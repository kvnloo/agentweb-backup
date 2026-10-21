import { scrubErrorText } from './voice/voiceProvider';

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** An error's message with credentials and phone numbers scrubbed and cut short: safe to log. */
export const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : 'unknown').slice(0, 200);
