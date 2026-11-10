/** ENG-2880. Durable first observations, not counters. Dark pending DATA-PLANE approval.
 * Existing tracker/session signals overwrite custom-event timestamps (last write wins),
 * so they cannot implement first occurrence across workers. Reuse AW-Users instead.
 */
export enum ActivationStage {
  SignedUp = 'signed_up',
  ApprovedFromWaitlist = 'approved_from_waitlist',
  LoggedIn = 'logged_in',
  OnboardingStarted = 'onboarding_started',
  OnboardingCompleted = 'onboarding_completed',
  AdAccountConnected = 'ad_account_connected',
  AdCreationStarted = 'ad_creation_started',
  AdCreationCompleted = 'ad_creation_completed',
  AdSubmitted = 'ad_submitted',
  AdPublished = 'ad_published',
  AdLaunchFailed = 'ad_launch_failed',
  ReturnedLaterDay = 'returned_later_day',
}
export type ErrorCategory = 'provider_rejected' | 'verification_mismatch' | 'verification_unavailable' | 'upstream_error';
export interface ActivationEvent { userId: string; timestamp: string; error_category?: ErrorCategory }
export type ActivationEvents = Partial<Record<ActivationStage, ActivationEvent>>;
export interface ActivationUser { userId: string; email: string; createdAt?: string; zomaActivationEvents?: ActivationEvents }
export interface ActivationDeps {
  enabled: () => boolean;
  getUser: (id: string) => Promise<ActivationUser | undefined>;
  writeFirst: (user: ActivationUser, stage: ActivationStage, event: ActivationEvent) => Promise<boolean>;
  now: () => number;
}
const defaults: ActivationDeps = {
  enabled: () => process.env.ZOMA_ACTIVATION_EVENTS_ENABLED === 'true',
  // Runtime require keeps the lightweight emitter/report independent of the DB monolith.
  getUser: (id) => require('./db').userDb.getUserById(id),
  writeFirst: (user, stage, event) => require('./db').userDb.recordZomaActivationEvent(user, stage, event),
  now: Date.now,
};
/** Best effort; analytics may never turn a successful business operation into a retry. */
export async function emitActivation(userId: string, stage: ActivationStage, error_category?: ErrorCategory, deps: ActivationDeps = defaults): Promise<boolean> {
  try {
    if (!deps.enabled() || !userId || !Object.values(ActivationStage).includes(stage)) return false;
    if (stage === ActivationStage.AdLaunchFailed && !error_category) return false;
    const user = await deps.getUser(userId);
    if (!user || user.zomaActivationEvents?.[stage]) return false;
    const timestamp = new Date(deps.now()).toISOString();
    if (stage === ActivationStage.ReturnedLaterDay) {
      // UTC calendar days, not elapsed 24 hours. No invented historical signup event.
      const first = user.zomaActivationEvents?.signed_up?.timestamp || user.createdAt;
      if (!first || !Number.isFinite(Date.parse(first)) || timestamp.slice(0, 10) <= new Date(first).toISOString().slice(0, 10)) return false;
    }
    return await deps.writeFirst(user, stage, { userId, timestamp, ...(stage === ActivationStage.AdLaunchFailed ? { error_category } : {}) });
  } catch {
    console.warn('[zoma-activation] event write failed', stage); // no email, token or provider error text
    return false;
  }
}
/** Signup hooks use the waitlist's durable approval timestamp, including approval before an account exists. */
export async function emitActivationSignup(userId: string, email: string, createdAt?: string): Promise<void> {
  // The account was just persisted. Do not re-resolve it through an eventually consistent GSI.
  const created = Date.parse(createdAt || '');
  const deps = { ...defaults, getUser: async () => ({ userId, email, createdAt }), now: Number.isFinite(created) ? () => created : defaults.now };
  await emitActivation(userId, ActivationStage.SignedUp, undefined, deps);
  if (!defaults.enabled()) return;
  try {
    const entry = await require('./waitlistDb').waitlistDb.getByEmail(email);
    if (entry?.status === 'invited' || entry?.status === 'completed') {
      const approvedAt = Date.parse(entry.invitedAt || '');
      await emitActivation(userId, ActivationStage.ApprovedFromWaitlist, undefined, {
        ...deps, now: Number.isFinite(approvedAt) ? () => approvedAt : deps.now,
      });
    }
  } catch { console.warn('[zoma-activation] approval lookup failed'); }
}
export async function emitWaitlistApproval(email: string): Promise<void> {
  if (!defaults.enabled()) return;
  try {
    const user = await require('./db').userDb.getUserByEmail(email);
    if (user) await emitActivation(user.userId, ActivationStage.ApprovedFromWaitlist);
  } catch { console.warn('[zoma-activation] approval lookup failed'); }
}
/** Called only after toolkit authentication; delegated admin portal traffic is not a return. */
export async function emitActivationLogin(userId: string): Promise<void> {
  await emitActivation(userId, ActivationStage.LoggedIn);
  await emitActivation(userId, ActivationStage.ReturnedLaterDay);
}
// Side branches are deliberately excluded: failure and return do not advance the funnel.
// Connection precedes completion semantically, even if callbacks arrive out of order.
export const PROGRESS_STAGES = [
  ActivationStage.SignedUp, ActivationStage.ApprovedFromWaitlist, ActivationStage.LoggedIn,
  ActivationStage.OnboardingStarted, ActivationStage.AdAccountConnected, ActivationStage.OnboardingCompleted,
  ActivationStage.AdCreationStarted, ActivationStage.AdCreationCompleted, ActivationStage.AdSubmitted, ActivationStage.AdPublished,
];
export function activationProgress(user: ActivationUser, now: number, stuckAfterHours = 24) {
  const events: ActivationEvents = {};
  for (const stage of Object.values(ActivationStage)) {
    const e = user.zomaActivationEvents?.[stage];
    if (e?.userId === user.userId && Number.isFinite(Date.parse(e.timestamp))) events[stage] = e;
  }
  const furthestStage = [...PROGRESS_STAGES].reverse().find(s => events[s]) ?? null;
  const lastProgressAt = Object.entries(events).filter(([s]) => PROGRESS_STAGES.includes(s as ActivationStage)).map(([, e]) => e!.timestamp).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const stuck = !!furthestStage && furthestStage !== ActivationStage.AdPublished && !!lastProgressAt && now - Date.parse(lastProgressAt) >= stuckAfterHours * 3600000;
  return {
    userId: user.userId, email: user.email, events, furthestStage, lastProgressAt,
    // Explicit activation definition: provider-confirmed publication, never signup or setup.
    activated: !!events.ad_published, stuck, stuckStage: stuck ? furthestStage : null,
    launchErrorCategory: events.ad_launch_failed?.error_category ?? null,
  };
}
export function buildActivationReport(users: ActivationUser[], now: number, stuckAfterHours = 24) {
  const rows = users.map(u => activationProgress(u, now, stuckAfterHours));
  const stuckByStage = Object.fromEntries(PROGRESS_STAGES.map(s => [s, rows.filter(r => r.stuckStage === s).map(r => r.userId)]));
  return { generatedAt: new Date(now).toISOString(), stuckAfterHours, activationDefinition: 'provider-confirmed ad_published', rows, stuckByStage };
}
export function activationCsv(rows: ReturnType<typeof activationProgress>[]): string {
  const headers = ['userId', 'email', 'furthestStage', 'activated', 'stuck', 'stuckStage', 'lastProgressAt', 'launchErrorCategory', ...Object.values(ActivationStage)];
  const cell = (v: unknown) => {
    const text = String(v ?? '');
    return '"' + (/^[=+@\-\t\r\n]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"';
  };
  return [headers, ...rows.map(r => headers.map(h => h in r ? (r as any)[h] : r.events[h as ActivationStage]?.timestamp ?? ''))].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
/** Toolkit result observer. Never infers live delivery from a preview, PAUSED create,
 * ACTIVE configured status alone, or an unconfirmed read-back. */
export async function observeActivationWrite(userId: string, args: any, execute: () => Promise<any>, emit = emitActivation) {
  const ad = args.entity_type === 'AD';
  const create = ad && args.action === 'CREATE';
  const launch = ad && args.action === 'UPDATE' && args.params?.status === 'ACTIVE';
  if (create) await emit(userId, ActivationStage.AdCreationStarted);
  let result;
  try { result = await execute(); }
  catch (error) {
    if (launch && args.confirm === true) await emit(userId, ActivationStage.AdLaunchFailed, 'upstream_error');
    throw error;
  }
  if (create && result?.verification === 'CONFIRMED' && result?.success === true) await emit(userId, ActivationStage.AdCreationCompleted);
  if (launch && result?.verification) {
    await emit(userId, ActivationStage.AdSubmitted);
    if (result.verification === 'CONFIRMED' && result.success === true && result.effective_status === 'ACTIVE') await emit(userId, ActivationStage.AdPublished);
    else if (result.verification !== 'CONFIRMED') await emit(userId, ActivationStage.AdLaunchFailed, result.verification === 'MISMATCH' ? 'verification_mismatch' : 'verification_unavailable');
  } else if (launch && result?.status === 'FAILED') await emit(userId, ActivationStage.AdLaunchFailed, 'provider_rejected');
  return result;
}
