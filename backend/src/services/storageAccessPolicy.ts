/**
 * ENG-2988: who may read or overwrite an object in the private file bucket.
 *
 * `/api/files/presign`, `/presign-batch`, `/content` and `/html` used to act on any key (or any URL of the bucket) for any signed-in user, so
 * user B could read, or overwrite, user A's file by naming its key (reproduced on the test environment). Every one of them now asks this
 * module, with the exact string it is about to sign, read or write.
 *
 * Two parts:
 *  1. `canonicalStorageKey`: turns what the caller sent into one canonical key, or refuses it. The check and the storage call use this same
 *     string, so a key that looks like the caller's own but resolves elsewhere (`users/me/../victim/f.png`, encoded dots, backslashes)
 *     cannot pass the check and then hit a different object.
 *  2. `decideStorageAccess`: finds the owner of the object from the key's shape (and, where the key does not carry the owner, from the task,
 *     execution or chat session it belongs to), then allows the owner, a real admin, and, for the shapes that are shared inside an
 *     organisation, a teammate (reads only). Anything it cannot place is refused (fail closed); only a real admin may touch those.
 *
 * This closes the API door only. The bucket itself still allows public reads by direct URL (no S3 public access block), so a file is only as
 * private as its key is hard to guess; locking the bucket is a separate access-policy decision.
 *
 * Key shapes and who writes them are listed in the brain note `finding-s3-key-shapes-and-presign-readers-2026-11-13`.
 */
import { userDb, taskDb, orgDb } from './db';
import { chatbotDb } from './chatbotService';
import { canViewItem, canEditItem } from './orgShareService';
import { isEvaluationUser } from './evaluationPolicy';

export type StorageAccess = 'read' | 'write';
export interface StorageCaller {
  userId: string;
  /** A real (non-delegated) admin. A delegated session acts as its target user, with no admin power. */
  isRealAdmin: boolean;
}
export type StorageDecision = { allow: true } | { allow: false; reason: string; shape: string };

const MAX_KEY_LENGTH = 1024;
/** Owners that are not users: nobody can own these, so only an admin may reach them. */
const PSEUDO_OWNERS = new Set(['anonymous', 'human-eval', 'workplans']);
/**
 * `users/<id>/<kind>/...` kinds that are shared inside an organisation (chat and tool files, creative library, KB media, brand assets,
 * branded videos). Every other kind (books, zoma-uploads, anything new or legacy) is the owner's alone until someone decides otherwise.
 */
const ORG_SHARED_USER_KINDS = new Set(['files', 'brand', 'remotion']);
/** An id as it appears in a key: ids are uuids, timestamps or `anon_<uuid>`. Anything else cannot name a record, so it is never looked up. */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const isPlainId = (id: string | undefined): id is string => typeof id === 'string' && PLAIN_ID.test(id);
/** Names that may appear in a log line; anything else is logged as `other`, because the rest of a key is chosen by the caller. */
const LOGGABLE_TOP_LEVELS = new Set(['users', 'tasks', 'tool-responses', 'workplans', 'sandbox', 'sandbox-datasets', 'execution_logs', 'task_results', 'screenshots']);
const LOGGABLE_USER_KINDS = new Set(['files', 'brand', 'books', 'zoma-uploads', 'remotion']);
const LOGGABLE_TASK_KINDS = new Set(['attachments', 'executions']);

/**
 * `source: 'key'` is a key as the client sent it (Express has already decoded it once). `source: 'url-path'` is the path of a bucket URL,
 * which is still percent-encoded and is decoded exactly once here (a raw, unencoded path with a stray `%` is taken as it is). At most one
 * leading `s3:` (the prefix task knowledge-base entries are stored with) is removed. Returns null for anything that could name more than one
 * object. `?` and `#` are refused in a client-sent key (they mean the caller pasted a URL) but are legal object name characters in a decoded
 * URL path, where they were escaped. `source: 'decoded'` is a key already made canonical by an earlier call (for example a directory plus a
 * rewritten file name): it is only validated again, never decoded or stripped a second time.
 */
export function canonicalStorageKey(raw: unknown, source: 'key' | 'url-path' | 'decoded'): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let key = raw;
  if (source === 'url-path') {
    try {
      key = decodeURIComponent(key);
    } catch {
      // not valid percent-encoding: a key built without encoding that contains a literal %; use it as it is
    }
  }
  if (source !== 'decoded' && key.startsWith('s3:')) key = key.slice(3);
  if (!key || key.length > MAX_KEY_LENGTH) return null;
  if (key.startsWith('/')) return null;
  const forbidden = source === 'key' ? /[\\?#\u0000-\u001f\u007f]/ : /[\\\u0000-\u001f\u007f]/;
  if (forbidden.test(key)) return null;
  const segments = key.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return key;
}

/** What may be written to a log about a key: its kind, never ids, file names or caller-chosen text. */
function shapeOf(key: string): string {
  const s = key.split('/');
  if (!LOGGABLE_TOP_LEVELS.has(s[0])) return 'other';
  if (s[0] === 'users') {
    if (s[1] === 'ishare-sessions') return 'users/*/ishare-sessions';
    if (PSEUDO_OWNERS.has(s[1])) return 'users/pseudo';
    if (s[1]?.startsWith('anon_')) return 'users/anon';
    return `users/*/${LOGGABLE_USER_KINDS.has(s[2]) ? s[2] : 'other'}`;
  }
  if (s[0] === 'tasks') return `tasks/*/${LOGGABLE_TASK_KINDS.has(s[2]) ? s[2] : 'other'}`;
  return `${s[0]}/*`;
}

/**
 * Per-request memo: a batch of 50 URLs usually names a handful of owners. A lookup that throws is treated as "not found" (so access is
 * refused) but is logged and remembered in `failed`, so an outage is told apart from a real refusal.
 */
export class StorageAccessLookups {
  /** True once any lookup in this request threw. */
  failed = false;
  /** Distinct records one request may look up. A batch of 50 URLs naming 50 made-up owners would otherwise cost 50 reads; past the limit a record counts as not found. */
  static readonly MAX_DISTINCT_LOOKUPS = 20;
  private loads = 0;
  private limitLogged = false;
  private users = new Map<string, Promise<any>>();
  private tasks = new Map<string, Promise<any>>();
  private executions = new Map<string, Promise<any>>();
  private sessions = new Map<string, Promise<any>>();
  private orgs = new Map<string, Promise<any>>();
  private memo<T>(m: Map<string, Promise<any>>, kind: string, id: string, load: () => Promise<T>): Promise<T | null> {
    let p = m.get(id);
    if (!p) {
      if (this.loads >= StorageAccessLookups.MAX_DISTINCT_LOOKUPS) {
        if (!this.limitLogged) {
          this.limitLogged = true;
          console.warn(JSON.stringify({ event: 'storage_access_lookup_limit', limit: StorageAccessLookups.MAX_DISTINCT_LOOKUPS }));
        }
        return Promise.resolve(null);
      }
      this.loads++;
      p = load().catch((error: any) => {
        this.failed = true;
        console.error(JSON.stringify({ event: 'storage_access_lookup_failed', kind, error: String(error?.message || error).slice(0, 200) }));
        return null;
      });
      m.set(id, p);
    }
    return p;
  }
  user(id: string) { return this.memo(this.users, 'user', id, async () => (await userDb.getUserById(id)) ?? null); }
  task(id: string) { return this.memo(this.tasks, 'task', id, async () => (await taskDb.getTaskById(id)) ?? null); }
  execution(id: string) { return this.memo(this.executions, 'execution', id, async () => (await taskDb.getTaskExecutionOwnerById(id)) ?? null); }
  session(id: string) { return this.memo(this.sessions, 'session', id, async () => (await chatbotDb.getChatSessionRecord(id)) ?? null); }
  org(id: string) { return this.memo(this.orgs, 'org', id, async () => (await orgDb.getOrgById(id)) ?? null); }
}

export async function decideStorageAccess(
  caller: StorageCaller,
  key: string,
  access: StorageAccess,
  lookups: StorageAccessLookups = new StorageAccessLookups(),
): Promise<StorageDecision> {
  const shape = shapeOf(key);
  const allow: StorageDecision = { allow: true };
  const deny = (reason: string): StorageDecision => ({ allow: false, reason, shape });
  const adminOr = (reason: string): StorageDecision => (caller.isRealAdmin ? allow : deny(reason));
  const s = key.split('/');

  /** The owner, a real admin, or (when `teammates`) someone in the owner's organisation. Writes never go to teammates. */
  const ownerRule = async (ownerId: string | undefined | null, teammates: boolean): Promise<StorageDecision> => {
    if (!ownerId) return adminOr('owner_unknown');
    if (ownerId === caller.userId) return allow;
    if (caller.isRealAdmin) return allow;
    if (!teammates || access === 'write') return deny('not_owner');
    const [me, owner] = await Promise.all([lookups.user(caller.userId), lookups.user(ownerId)]);
    if (!me?.orgId || !owner?.orgId) return deny('not_teammate');
    return me.orgId === owner.orgId ? allow : deny('not_teammate');
  };

  /**
   * A task's own files (attachments, knowledge-base media): the task owner, a real admin, or an org member the knowledge-base share rule allows:
   * the same rule as the task routes, so for writes that is an organisation owner or admin, or a listed editor (a plain member may read only).
   * Every other shape in this file is read-only for teammates.
   */
  const taskRule = async (taskId: string): Promise<StorageDecision> => {
    const task = await lookups.task(taskId);
    if (!task?.userId) return adminOr('task_missing');
    if (task.userId === caller.userId || caller.isRealAdmin) return allow;
    const [me, owner] = await Promise.all([lookups.user(caller.userId), lookups.user(task.userId)]);
    if (!me?.orgId || !owner?.orgId || me.orgId !== owner.orgId) return deny('not_teammate');
    const org = await lookups.org(me.orgId);
    const viewer = { userId: caller.userId, orgId: me.orgId, orgRole: me.orgRole };
    const decide = access === 'write' ? canEditItem : canViewItem;
    return decide({ userId: task.userId }, viewer, org, owner.orgId, 'knowledgeBase') ? allow : deny('knowledge_base_not_shared');
  };

  /**
   * An execution's files: the execution row names the owner (it outlives a deleted task), and must belong to the task in the key when the
   * key has one; if the row is gone, fall back to the task.
   */
  const executionRule = async (taskId: string, executionId: string | undefined): Promise<StorageDecision> => {
    if (executionId !== undefined && !isPlainId(executionId)) return adminOr('invalid_id');
    if (taskId && !isPlainId(taskId)) return adminOr('invalid_id');
    const execution = executionId ? await lookups.execution(executionId) : null;
    if (execution?.userId) {
      if (taskId && execution.taskId && execution.taskId !== taskId) return adminOr('execution_task_mismatch');
      return ownerRule(execution.userId, true);
    }
    // No execution row: either it is gone or the lookup failed. Falling back to the task would skip the check that the execution belongs to
    // the task in the key, so when the lookup failed, refuse (the answer is "try again").
    if (executionId && lookups.failed) return deny('lookup_failed');
    const task = taskId ? await lookups.task(taskId) : null;
    return ownerRule(task?.userId, true);
  };

  const compute = async (): Promise<StorageDecision> => {
    switch (s[0]) {
      case 'users': {
        const id = s[1];
        if (!id || s.length < 3) return adminOr('unknown_shape');
        if (PSEUDO_OWNERS.has(id)) return adminOr('no_owner');
        if (id.startsWith('anon_')) {
          // Files from an anonymous visitor's plan session. The session moves to the visitor's new account at sign-up but its keys keep the old
          // `anon_` id, which no user record carries, so nobody can be shown to own them: any signed-in user may read them (they are the visitor's
          // own results, shown to them after sign-up), only an admin may change them.
          return access === 'read' ? allow : adminOr('anonymous_owner');
        }
        if (id === 'ishare-sessions') {
          const session = s.length >= 4 && isPlainId(s[2]) ? await lookups.session(s[2]) : null;
          return ownerRule(session?.userId, false);
        }
        // The owner's own keys need no lookup. For anyone else the id in the key must be a real user, or nobody owns it (admin only).
        if (id !== caller.userId && !caller.isRealAdmin && (!isPlainId(id) || !(await lookups.user(id)))) return deny('owner_missing');
        return ownerRule(id, ORG_SHARED_USER_KINDS.has(s[2]));
      }
      case 'tasks': {
        if (!s[1] || !isPlainId(s[1])) return adminOr('unknown_shape');
        if (s[2] === 'executions') return executionRule(s[1], s[3]);
        return taskRule(s[1]);
      }
      case 'tool-responses': {
        const session = isPlainId(s[1]) ? await lookups.session(s[1]) : null;
        return ownerRule(session?.userId, false);
      }
      case 'workplans':
        // Platform artwork with a public cache header: any signed-in user may read it; only an admin may change it.
        return access === 'read' ? allow : adminOr('not_admin');
      case 'sandbox':
        return s[1] === caller.userId || caller.isRealAdmin ? allow : deny('not_owner');
      case 'sandbox-datasets':
        return access === 'read' && isEvaluationUser(caller.userId) ? allow : adminOr('not_evaluation');
      case 'execution_logs':
        return isPlainId(s[1]) ? ownerRule(s[1], false) : adminOr('unknown_shape');
      case 'task_results':
      case 'screenshots':
        return executionRule('', s[1]);
      default:
        return adminOr('unknown_shape');
    }
  };

  const decision = await compute();
  // A refusal that followed a failed lookup is not a verdict on the caller: say so, so the route can answer "try again" and the log can tell.
  if (!decision.allow && lookups.failed) return { allow: false, reason: 'lookup_failed', shape };
  return decision;
}
