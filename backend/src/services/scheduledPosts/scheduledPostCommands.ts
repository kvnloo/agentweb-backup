/**
 * ENG-2746 (slice of ENG-2501): command layer (create/list/edit/cancel) the future
 * Emma scheduling tool will call. Pure over an injected repository port — no table,
 * no scheduler wiring, no tool registration (persistence + plan gating stay on ENG-2501).
 *
 * Every command is owner-scoped and returns a typed result; none throws on bad input.
 */
import { ScheduledPostRepository } from './dispatchDuePosts';
import {
  formatScheduledPostList,
  type ScheduledPostListView,
} from './formatScheduledPostList';
import { ScheduledPostRecord, transition, type TransitionErrorCode } from './scheduledPostLifecycle';
import {
  validateScheduledPostRequest,
  type ScheduledPostError,
  type ScheduledPostPlatform,
} from './validateScheduledPostRequest';

/** A stored post with its owner and target platform. */
export interface OwnedScheduledPost extends ScheduledPostRecord {
  userId: string;
  platform: ScheduledPostPlatform;
}

/** Dispatcher port plus the owner-scoped read the command layer needs. */
export interface ScheduledPostCommandRepository extends ScheduledPostRepository {
  get(id: string): Promise<OwnedScheduledPost | undefined>;
  save(record: OwnedScheduledPost): Promise<void>;
  listByUser(userId: string): Promise<OwnedScheduledPost[]>;
  /**
   * Atomically write `record` only if the stored row still has `expected.status` and
   * `expected.updatedAt` (optimistic concurrency). Returns false when the row changed
   * since it was read, so a stale edit can never resurrect a cancelled/fired post.
   */
  saveIfUnchanged(
    record: OwnedScheduledPost,
    expected: { status: OwnedScheduledPost['status']; updatedAt?: Date },
  ): Promise<boolean>;
}

export interface ScheduledPostCommandDeps {
  repo: ScheduledPostCommandRepository;
  now: () => Date;
  userId: string;
  newId: () => string;
}

export type CommandErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | TransitionErrorCode;

export type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CommandErrorCode; message: string; errors?: ScheduledPostError[] };

export async function createScheduledPost(
  deps: ScheduledPostCommandDeps,
  input: unknown,
): Promise<CommandResult<OwnedScheduledPost>> {
  const validation = validateScheduledPostRequest(input, deps.now);
  if (!validation.ok) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid scheduled post request.', errors: validation.errors };
  }
  const now = deps.now();
  const record: OwnedScheduledPost = {
    id: deps.newId(),
    userId: deps.userId,
    status: 'pending',
    platform: validation.value.platform,
    publishAt: validation.value.publishAt,
    content: validation.value.content,
    mediaUrls: validation.value.mediaUrls,
    updatedAt: now,
  };
  await deps.repo.save(record);
  return { ok: true, value: record };
}

export async function listScheduledPosts(
  deps: ScheduledPostCommandDeps,
  opts: { timeZone: string; includeInactive?: boolean },
): Promise<ScheduledPostListView> {
  const records = (await deps.repo.listByUser(deps.userId)).filter((r) => r.userId === deps.userId);
  return formatScheduledPostList(records, { now: deps.now(), ...opts });
}

async function loadOwned(deps: ScheduledPostCommandDeps, id: string): Promise<OwnedScheduledPost | undefined> {
  const record = await deps.repo.get(id);
  // Another user's post is indistinguishable from a missing one.
  return record && record.userId === deps.userId ? record : undefined;
}

async function applyTransition(
  deps: ScheduledPostCommandDeps,
  id: string,
  action: Parameters<typeof transition>[1],
  preloaded?: OwnedScheduledPost,
): Promise<CommandResult<OwnedScheduledPost>> {
  const record = preloaded ?? (await loadOwned(deps, id));
  if (!record) return { ok: false, code: 'NOT_FOUND', message: `No scheduled post ${id}.` };
  const result = transition(record, action);
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  const next: OwnedScheduledPost = { ...record, ...result.record, userId: record.userId, platform: record.platform };
  if (result.changed) {
    const saved = await deps.repo.saveIfUnchanged(next, { status: record.status, updatedAt: record.updatedAt });
    if (!saved) {
      return { ok: false, code: 'CONFLICT', message: `Scheduled post ${id} changed concurrently; reload and retry.` };
    }
  }
  return { ok: true, value: next };
}

type EditableChanges = Partial<Pick<ScheduledPostRecord, 'publishAt' | 'content' | 'mediaUrls'>>;

export async function editScheduledPost(
  deps: ScheduledPostCommandDeps,
  id: string,
  changes: EditableChanges,
): Promise<CommandResult<OwnedScheduledPost>> {
  // Allowlist: only these fields may change via edit, whatever the caller's object carries.
  const allowed: EditableChanges = {};
  if (changes.publishAt !== undefined) allowed.publishAt = changes.publishAt;
  if (changes.content !== undefined) allowed.content = changes.content;
  if (changes.mediaUrls !== undefined) allowed.mediaUrls = changes.mediaUrls;

  const record = await loadOwned(deps, id);
  if (!record) return { ok: false, code: 'NOT_FOUND', message: `No scheduled post ${id}.` };
  // Re-apply the create rules to the post as it would look after the edit. Only pending
  // posts can be edited, so skip validation for others and let transition() report it.
  if (record.status === 'pending') {
    const at = allowed.publishAt ?? record.publishAt;
    const validAt = at instanceof Date && !Number.isNaN(at.getTime());
    const validation = validateScheduledPostRequest(
      {
        platform: record.platform,
        publishAt: validAt ? at.toISOString() : '',
        content: allowed.content ?? record.content,
        mediaUrls: allowed.mediaUrls ?? record.mediaUrls,
      },
      deps.now,
    );
    if (!validation.ok) {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid scheduled post edit.', errors: validation.errors };
    }
  }
  return applyTransition(deps, id, { type: 'edit', now: deps.now(), changes: allowed }, record);
}

export async function cancelScheduledPost(
  deps: ScheduledPostCommandDeps,
  id: string,
): Promise<CommandResult<OwnedScheduledPost>> {
  return applyTransition(deps, id, { type: 'cancel', now: deps.now() });
}
