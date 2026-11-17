/**
 * ENG-2816 (step 3): which content of a schedule was written by a share-link visitor.
 *
 * A share link runs the visitor's turn under the OWNER's userId, so a schedule a visitor creates or edits is stored as the
 * owner's own and, unless something says otherwise, runs later with the owner's full tool set. `provenance` is that something:
 * ONE optional String Set on a schedule item (`AW-TaskSchedules`), each member naming a tracked content field whose current
 * value a visitor wrote. A schedule is "marked" when the set is non-empty; a marked schedule's runs get the
 * `share_visitor_schedule` restriction profile (toolRestrictionProfiles.ts), enforced live in `executeTool`.
 *
 * It is absent on every schedule that existed before this change and is never backfilled, so an unmarked schedule behaves
 * exactly as it always did. Over-marking is safe (the owner can adopt it); under-marking is the hole this exists to close, so
 * everything here fails toward "marked".
 *
 * This module imports nothing, so the pure publish-authorization resolver and the database layer can both use it without an
 * import cycle.
 */

/**
 * The content fields a visitor can change that steer a later run: the prompt, the words and tool names the retry message pastes
 * in, the variable definitions and values substituted into the prompt, and the recipients (a visitor-chosen recipient also
 * receives the emailed variables link). Not tracked, on purpose: `session_id` (create-only), `self_improve`, timing, `llmModel`,
 * name and description.
 */
export const SCHEDULE_PROVENANCE_FIELDS = [
  'startingMessage',
  'keywords',
  'requiredFunctionCalls',
  'functionCallMinCalls',
  'variables',
  'variableValues',
  'emailNotifications',
] as const;

export type ScheduleProvenanceField = (typeof SCHEDULE_PROVENANCE_FIELDS)[number];

/** What an unreadable attribute reads as: some mark we cannot interpret is still a mark. */
export const UNREADABLE_PROVENANCE = '_unreadable';

/**
 * The tolerant reader: every place that asks "which fields are marked" goes through this one function, whatever shape the value
 * has in the caller's hand. A DynamoDB String Set (the DocumentClient's `DynamoDBSet`, with `.values`), a JS `Set`, a plain
 * array (what the db layer and the API return) all read as their members, sorted and de-duplicated. Absent (undefined or null)
 * reads as none. Anything else we cannot parse reads as MARKED (`[UNREADABLE_PROVENANCE]`), never as none.
 */
export function readScheduleProvenance(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];

  let members: unknown[];
  if (Array.isArray(raw)) {
    members = raw;
  } else if (raw instanceof Set) {
    members = [...raw];
  } else if (typeof raw === 'object' && Array.isArray((raw as { values?: unknown }).values)) {
    members = (raw as { values: unknown[] }).values;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    members = [raw];
  } else {
    return [UNREADABLE_PROVENANCE];
  }

  const read = new Set<string>();
  for (const member of members) {
    read.add(typeof member === 'string' && member.trim() !== '' ? member : UNREADABLE_PROVENANCE);
  }
  return [...read].sort();
}

/** True when a visitor wrote some of this schedule's content. A missing schedule is not "marked": callers decide what missing means. */
export function isScheduleMarked(schedule: { provenance?: unknown } | null | undefined): boolean {
  return readScheduleProvenance(schedule?.provenance).length > 0;
}

/** The tracked fields a request body carries (present means "not undefined": JSON drops undefined, so a field the caller left out is absent). */
export function trackedFieldsInBody(body: unknown): ScheduleProvenanceField[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  return SCHEDULE_PROVENANCE_FIELDS.filter((field) => record[field] !== undefined);
}

/**
 * Tools whose self-call reaches a schedule WRITE route. Their calls inside a marked run carry the run's restriction profile
 * (see agentModeService.executeTool), so a marked run's own `manage_scheduled_chat update` (the self-improvement reflection turn
 * does exactly that) is itself a visitor write: it re-marks what it writes and can never lift or launder the mark.
 */
export const SCHEDULE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'manage_scheduled_chat',
  'submit_scheduled_chat_variables',
  'create_schedule_from_template',
  'manage_schedule_template',
  'emma_schedule_recurring_work',
]);

/**
 * Whether the owner's "full autonomy" waiver (ENG-396: a headless run auto-takes Emma's recommended option on a blocking question,
 * even an irreversible one) applies to this schedule's run. It is the owner's opt-in for a prompt THEY wrote, so a schedule a
 * share-link visitor wrote into does not get it until the owner adopts the schedule.
 */
export function autonomyWaiverApplies(schedule: { fullAutonomy?: unknown; provenance?: unknown } | null | undefined): boolean {
  return schedule?.fullAutonomy === true && !isScheduleMarked(schedule);
}

/** Retry attempts a marked run gets. An unmarked run keeps its 20; a marked run's refused calls would otherwise burn the owner's credits on them. */
export const MARKED_RUN_MAX_ATTEMPTS = 3;

/** `names` without those the profile refuses (the deterministic checker must not demand a tool the run is forbidden to call). */
export function withoutRefusedNames(names: string[] | undefined, isRefused: (name: string) => boolean): string[] {
  return (Array.isArray(names) ? names : []).filter((name) => !isRefused(name));
}

/** The map `functionCallMinCalls` without the refused names (same reason as `withoutRefusedNames`). */
export function minCallsWithoutRefused(
  minCalls: Record<string, number> | undefined,
  isRefused: (name: string) => boolean
): Record<string, number> {
  const source = minCalls && typeof minCalls === 'object' ? minCalls : {};
  return Object.fromEntries(Object.entries(source).filter(([name]) => !isRefused(name)));
}

/** What one write does to a schedule's provenance: members to add, or members to remove, never both (see `updateSchedule`). */
export interface ProvenancePlan {
  provenanceAdd?: string[];
  provenanceRemove?: string[];
}

/**
 * Decide what a schedule write does to its provenance. Marking and lifting are NOT symmetric, on purpose:
 *
 *  - a VISITOR's write marks every tracked field the request carries (presence, not change: over-marking is safe, and a visitor
 *    re-sending the owner's own value still means the visitor is now the last writer of it);
 *  - the mark comes off ONLY on positive evidence that the owner themselves changed the content: a real portal login (not a
 *    self-call, not a delegate, not a visitor's write), for a field that is in the request AND whose new value differs from the
 *    stored one. The portal posts the whole form on every save, so "the field was sent" proves nothing; "the value changed"
 *    does. Anything else leaves the marks alone. A self-call (Emma in the owner's own chat, a marked run's own reflection turn)
 *    never lifts: it cannot tell the owner from a visitor.
 *
 * Pure: the caller works out the four inputs from the request and the stored schedule.
 */
export function planProvenanceChange(input: {
  visitorWrite: boolean;
  ownerMayLift: boolean;
  /** The schedule's current marks, as read (`readScheduleProvenance`). */
  stored: string[];
  /** The tracked fields the request carries. */
  presentFields: string[];
  /** Of those, the ones whose new value differs from what is stored. */
  changedFields: string[];
}): ProvenancePlan {
  if (input.visitorWrite) {
    return input.presentFields.length > 0 ? { provenanceAdd: [...input.presentFields] } : {};
  }
  if (!input.ownerMayLift) return {};
  const lifted = input.changedFields.filter((field) => input.stored.includes(field));
  return lifted.length > 0 ? { provenanceRemove: lifted } : {};
}

/** The marks a schedule will carry once `plan` has been applied to `stored` (for a run that starts from the pre-write snapshot). */
export function applyProvenancePlan(stored: string[], plan: ProvenancePlan): string[] {
  const next = new Set(stored);
  for (const field of plan.provenanceAdd ?? []) next.add(field);
  for (const field of plan.provenanceRemove ?? []) next.delete(field);
  return [...next].sort();
}
