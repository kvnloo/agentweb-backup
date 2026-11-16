import { format, formatDistanceToNowStrict } from 'date-fns';

/** 41 ms · 8.2 s · 39 s · 6m 51s — never "411s". */
export function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Offset from the run start as +m:ss, for rows inside one run. */
export function formatOffset(fromIso?: string, toMs?: number): string | undefined {
  if (!fromIso || toMs == null) return undefined;
  const start = Date.parse(fromIso);
  if (!Number.isFinite(start)) return undefined;
  const diff = Math.max(0, Math.round((toMs - start) / 1000));
  return `+${Math.floor(diff / 60)}:${String(diff % 60).padStart(2, '0')}`;
}

export function formatDateTime(value?: string): string {
  if (!value) return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return format(date, 'EEE d MMM yyyy, HH:mm:ss');
}

/** Oct 14, 15:30 — distinguishes runs of one session in a list. */
export function formatShortDateTime(value?: string): string {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : format(date, 'MMM d, HH:mm');
}

export function formatTime(value?: string): string {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : format(date, 'HH:mm:ss');
}

export function formatRelative(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : `${formatDistanceToNowStrict(date)} ago`;
}

export function formatTokens(n?: number): string {
  if (n == null) return '–';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(usd?: number): string {
  if (usd == null) return '–';
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

export function formatChars(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(n >= 10_240 ? 0 : 1)} KB` : `${n} chars`;
}

export function shortId(value?: string, head = 8): string {
  if (!value) return '–';
  return value.length <= head + 5 ? value : `${value.slice(0, head)}…${value.slice(-4)}`;
}
