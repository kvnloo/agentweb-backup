/**
 * ENG-2751 (slice of ENG-2501): the `schedule_social_post` agent tool definition and
 * its handler. The handler depends only on injected ports:
 *  - a command-service port with the same shape as ENG-2746's create/list/edit/cancel
 *  - a wall-clock + IANA timezone -> zoned ISO resolver (ENG-2748 contract, injected)
 *
 * Not registered in the production tool registry. Exposure is gated by
 * SCHEDULE_SOCIAL_POST_TOOL_ENABLED (default off); enabling it and choosing the
 * persistence store remain the ENG-2501 Requires: Me decision.
 *
 * The handler never throws on bad input: every failure is a structured tool result.
 */
import type { CommandErrorCode, CommandResult, OwnedScheduledPost } from './scheduledPostCommands';
import type { ScheduledPostListView } from './formatScheduledPostList';
import type { ScheduledPostError } from './validateScheduledPostRequest';
import { SCHEDULED_POST_PLATFORMS } from './validateScheduledPostRequest';

export const SCHEDULE_SOCIAL_POST_TOOL_NAME = 'schedule_social_post';
export const SCHEDULE_SOCIAL_POST_FLAG = 'SCHEDULE_SOCIAL_POST_TOOL_ENABLED';

/** Flag off unless explicitly "true". */
export function isScheduleSocialPostToolEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SCHEDULE_SOCIAL_POST_FLAG] === 'true';
}

export const SCHEDULE_SOCIAL_POST_ACTIONS = ['create', 'list', 'edit', 'cancel'] as const;
export type ScheduleSocialPostAction = (typeof SCHEDULE_SOCIAL_POST_ACTIONS)[number];

export const scheduleSocialPostToolDefinition = {
  type: 'function' as const,
  function: {
    name: SCHEDULE_SOCIAL_POST_TOOL_NAME,
    description:
      'Schedule an approved social post to publish at a specific date/time, or list, edit, or cancel scheduled posts. ' +
      'publishAt is a local wall-clock time (YYYY-MM-DDTHH:mm, no offset) and timeZone is the IANA zone it is in, ' +
      'e.g. "America/Los_Angeles". Always confirm the time and timezone with the user before creating.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: [...SCHEDULE_SOCIAL_POST_ACTIONS] },
        postId: { type: 'string', description: 'Required for edit and cancel.' },
        platform: { type: 'string', enum: [...SCHEDULED_POST_PLATFORMS], description: 'Required for create.' },
        content: { type: 'string', description: 'Exact approved post text. Required for create.' },
        mediaUrls: { type: 'array', items: { type: 'string' }, description: 'Optional http(s) media URLs.' },
        publishAt: { type: 'string', description: 'Local wall-clock datetime, e.g. 2026-11-03T09:30.' },
        timeZone: {
          type: 'string',
          description: 'IANA timezone for publishAt (required whenever publishAt is given; also used to render list).',
        },
        includeInactive: { type: 'boolean', description: 'list only: include published/cancelled posts.' },
      },
    },
  },
};

/** ENG-2746 command-service port, bound to the calling user. */
export interface ScheduledPostCommandPort {
  create(input: unknown): Promise<CommandResult<OwnedScheduledPost>>;
  list(opts: { timeZone: string; includeInactive?: boolean }): Promise<ScheduledPostListView>;
  edit(
    id: string,
    changes: Partial<Pick<OwnedScheduledPost, 'publishAt' | 'content' | 'mediaUrls'>>,
  ): Promise<CommandResult<OwnedScheduledPost>>;
  cancel(id: string): Promise<CommandResult<OwnedScheduledPost>>;
}

/** ENG-2748 resolver contract: wall-clock + IANA zone -> zoned ISO string, or a typed error. */
export type PublishAtResolver = (
  wallClock: string,
  timeZone: string,
) => { ok: true; iso: string } | { ok: false; code: string; message: string };

export interface ScheduleSocialPostDeps {
  commands: ScheduledPostCommandPort;
  resolvePublishAt: PublishAtResolver;
}

export type ToolErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'TIMEZONE_REQUIRED'
  | 'TIMEZONE_INVALID'
  | CommandErrorCode
  | 'INTERNAL_ERROR';

export type ScheduleSocialPostResult =
  | { success: true; action: ScheduleSocialPostAction; post?: ScheduledPostSummary; list?: ScheduledPostListView; message: string }
  | { success: false; action?: string; code: ToolErrorCode | string; message: string; errors?: ScheduledPostError[] };

export interface ScheduledPostSummary {
  id: string;
  platform: string;
  status: string;
  publishAt: string;
  content: string;
  mediaUrls: string[];
}

function summarize(p: OwnedScheduledPost): ScheduledPostSummary {
  return {
    id: p.id,
    platform: p.platform,
    status: p.status,
    publishAt: p.publishAt.toISOString(),
    content: p.content,
    mediaUrls: p.mediaUrls,
  };
}

const fail = (code: string, message: string, action?: string, errors?: ScheduledPostError[]): ScheduleSocialPostResult => ({
  success: false,
  ...(action ? { action } : {}),
  code,
  message,
  ...(errors ? { errors } : {}),
});

function isValidIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Resolve publishAt + timeZone to a zoned ISO string, or a structured agent-facing error. */
function resolveTime(
  deps: ScheduleSocialPostDeps,
  args: Record<string, unknown>,
  action: string,
): { ok: true; iso: string } | { ok: false; result: ScheduleSocialPostResult } {
  const publishAt = args.publishAt;
  const timeZone = args.timeZone;
  if (typeof publishAt !== 'string' || publishAt.trim() === '') {
    return { ok: false, result: fail('INVALID_ARGUMENTS', 'publishAt (local wall-clock, e.g. 2026-11-03T09:30) is required.', action) };
  }
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    return {
      ok: false,
      result: fail(
        'TIMEZONE_REQUIRED',
        'timeZone is required with publishAt. Ask the user which timezone they mean and pass an IANA name such as "America/New_York".',
        action,
      ),
    };
  }
  if (!isValidIanaZone(timeZone)) {
    return { ok: false, result: fail('TIMEZONE_INVALID', `"${timeZone}" is not a valid IANA timezone.`, action) };
  }
  const resolved = deps.resolvePublishAt(publishAt, timeZone);
  if (!resolved.ok) return { ok: false, result: fail(resolved.code, resolved.message, action) };
  return { ok: true, iso: resolved.iso };
}

function fromCommand(
  action: ScheduleSocialPostAction,
  r: CommandResult<OwnedScheduledPost>,
  okMessage: (p: OwnedScheduledPost) => string,
): ScheduleSocialPostResult {
  if (!r.ok) return fail(r.code, r.message, action, r.errors);
  return { success: true, action, post: summarize(r.value), message: okMessage(r.value) };
}

function requirePostId(args: Record<string, unknown>, action: string): string | ScheduleSocialPostResult {
  const id = args.postId;
  if (typeof id !== 'string' || id.trim() === '') return fail('INVALID_ARGUMENTS', `postId is required for ${action}.`, action);
  return id;
}

export async function handleScheduleSocialPost(
  deps: ScheduleSocialPostDeps,
  rawArgs: unknown,
): Promise<ScheduleSocialPostResult> {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return fail('INVALID_ARGUMENTS', 'Arguments must be an object.');
  }
  const args = rawArgs as Record<string, unknown>;
  const action = args.action;
  if (typeof action !== 'string' || !(SCHEDULE_SOCIAL_POST_ACTIONS as readonly string[]).includes(action)) {
    return fail('INVALID_ARGUMENTS', `action must be one of: ${SCHEDULE_SOCIAL_POST_ACTIONS.join(', ')}.`);
  }

  try {
    switch (action as ScheduleSocialPostAction) {
      case 'create': {
        const t = resolveTime(deps, args, action);
        if (!t.ok) return t.result;
        const r = await deps.commands.create({
          platform: args.platform,
          content: args.content,
          mediaUrls: args.mediaUrls,
          publishAt: t.iso,
        });
        return fromCommand('create', r, (p) => `Scheduled ${p.platform} post ${p.id} for ${p.publishAt.toISOString()}.`);
      }
      case 'list': {
        const tz = args.timeZone;
        if (typeof tz !== 'string' || tz.trim() === '') {
          return fail('TIMEZONE_REQUIRED', 'timeZone (IANA) is required to show scheduled times in the user\'s local time.', action);
        }
        if (!isValidIanaZone(tz)) return fail('TIMEZONE_INVALID', `"${tz}" is not a valid IANA timezone.`, action);
        const list = await deps.commands.list({ timeZone: tz, includeInactive: args.includeInactive === true });
        return { success: true, action: 'list', list, message: list.text };
      }
      case 'edit': {
        const id = requirePostId(args, action);
        if (typeof id !== 'string') return id;
        const changes: Partial<Pick<OwnedScheduledPost, 'publishAt' | 'content' | 'mediaUrls'>> = {};
        if (args.publishAt !== undefined || args.timeZone !== undefined) {
          const t = resolveTime(deps, args, action);
          if (!t.ok) return t.result;
          changes.publishAt = new Date(t.iso);
        }
        if (args.content !== undefined) {
          if (typeof args.content !== 'string') return fail('INVALID_ARGUMENTS', 'content must be text.', action);
          changes.content = args.content;
        }
        if (args.mediaUrls !== undefined) {
          if (!Array.isArray(args.mediaUrls) || !args.mediaUrls.every((u) => typeof u === 'string')) {
            return fail('INVALID_ARGUMENTS', 'mediaUrls must be an array of URLs.', action);
          }
          changes.mediaUrls = args.mediaUrls as string[];
        }
        if (Object.keys(changes).length === 0) {
          return fail('INVALID_ARGUMENTS', 'edit needs at least one of publishAt+timeZone, content, or mediaUrls.', action);
        }
        const r = await deps.commands.edit(id, changes);
        return fromCommand('edit', r, (p) => `Updated scheduled post ${p.id}.`);
      }
      case 'cancel': {
        const id = requirePostId(args, action);
        if (typeof id !== 'string') return id;
        const r = await deps.commands.cancel(id);
        return fromCommand('cancel', r, (p) => `Cancelled scheduled post ${p.id}.`);
      }
    }
  } catch (err) {
    // Log internals server-side only; the agent-facing result stays generic so store/driver
    // error text (SQL, hostnames, table names) never reaches the model or user.
    console.error(`[schedule_social_post] ${action} failed`, err);
    return fail('INTERNAL_ERROR', `schedule_social_post ${action} failed due to an internal error. Please try again later.`, action);
  }
  return fail('INVALID_ARGUMENTS', 'Unsupported action.');
}
