/**
 * ENG-2511 (slice of ENG-2501): pure formatter for the chat-facing "upcoming
 * scheduled posts" view Emma shows before anything fires.
 *
 * No persistence, no I/O, no Date.now(): callers pass `now` and the user's IANA
 * timezone, so output is fully determined by the inputs.
 */
import { SCHEDULED_POST_PLATFORMS, type ScheduledPostPlatform } from './validateScheduledPostRequest';

export type ScheduledPostStatus = 'pending' | 'fired' | 'cancelled';

/** Minimal structural record: ValidScheduledPost fields plus id + status. */
export interface ScheduledPostListRecord {
  id: string;
  platform: ScheduledPostPlatform;
  publishAt: Date;
  content: string;
  mediaUrls: string[];
  status: ScheduledPostStatus;
}

export interface FormatScheduledPostListOptions {
  now: Date;
  /** IANA timezone, e.g. "America/Los_Angeles". */
  timeZone: string;
  /** Include fired/cancelled records (default false). */
  includeInactive?: boolean;
}

export const SCHEDULED_POST_PREVIEW_LENGTH = 80;

export const PLATFORM_LABELS: Record<ScheduledPostPlatform, string> = {
  x: 'X',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
};

export interface ScheduledPostRow {
  id: string;
  platform: ScheduledPostPlatform;
  status: ScheduledPostStatus;
  localTime: string;
  relativeTime: string;
  preview: string;
  mediaCount: number;
  pastDue: boolean;
  line: string;
}

export interface ScheduledPostGroup {
  platform: ScheduledPostPlatform;
  label: string;
  rows: ScheduledPostRow[];
}

export type ScheduledPostListView =
  | { empty: true; text: string; groups: [] }
  | { empty: false; text: string; groups: ScheduledPostGroup[] };

export const NOTHING_SCHEDULED_TEXT = 'Nothing scheduled.';

export function truncatePreview(content: string, max = SCHEDULED_POST_PREVIEW_LENGTH): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const chars = [...flat]; // code points, so emoji are not split
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export function formatRelativeTime(target: Date, now: Date): string {
  const diffMs = target.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const min = Math.round(abs / 60_000);
  let amount: string;
  if (min < 1) return 'now';
  if (min < 60) amount = `${min}m`;
  else if (min < 48 * 60) amount = `${Math.round(min / 60)}h`;
  else amount = `${Math.round(min / (24 * 60))}d`;
  return diffMs >= 0 ? `in ${amount}` : `${amount} ago`;
}

export function formatLocalTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);
}

export function formatScheduledPostList(
  records: readonly ScheduledPostListRecord[],
  options: FormatScheduledPostListOptions,
): ScheduledPostListView {
  const { now, timeZone, includeInactive = false } = options;
  const visible = records.filter((r) => includeInactive || r.status === 'pending');

  if (visible.length === 0) {
    return { empty: true, text: NOTHING_SCHEDULED_TEXT, groups: [] };
  }

  const groups: ScheduledPostGroup[] = [];
  for (const platform of SCHEDULED_POST_PLATFORMS) {
    const rows = visible
      .filter((r) => r.platform === platform)
      .sort((a, b) => a.publishAt.getTime() - b.publishAt.getTime() || a.id.localeCompare(b.id))
      .map((r): ScheduledPostRow => {
        const pastDue = r.status === 'pending' && r.publishAt.getTime() <= now.getTime();
        const localTime = formatLocalTime(r.publishAt, timeZone);
        const relativeTime = formatRelativeTime(r.publishAt, now);
        const preview = truncatePreview(r.content);
        const mediaCount = r.mediaUrls.length;
        const flags = [
          pastDue ? 'PAST DUE' : null,
          r.status !== 'pending' ? r.status.toUpperCase() : null,
        ].filter(Boolean);
        const media = mediaCount > 0 ? ` [${mediaCount} media]` : '';
        const flagText = flags.length ? ` (${flags.join(', ')})` : '';
        const line = `- ${localTime} (${relativeTime})${flagText}: "${preview}"${media} — id ${r.id}`;
        return { id: r.id, platform, status: r.status, localTime, relativeTime, preview, mediaCount, pastDue, line };
      });
    if (rows.length > 0) groups.push({ platform, label: PLATFORM_LABELS[platform], rows });
  }

  const text = groups.map((g) => [`${g.label}:`, ...g.rows.map((r) => r.line)].join('\n')).join('\n\n');
  return { empty: false, text, groups };
}
