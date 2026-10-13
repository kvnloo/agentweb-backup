/**
 * ENG-1611: bounded pagination for GET /api/agent-mode/scheduled-chats.
 *
 * The cursor is an opaque base64url token over an offset into the
 * newest-first list. Callers must treat it as opaque.
 */
export const SCHEDULED_CHATS_MAX_LIMIT = 100;
export const SCHEDULED_CHATS_DEFAULT_LIMIT = 50;

export type ScheduledChatsPage = { limit: number; offset: number } | { error: string };

/** Encodes an offset as an opaque cursor. */
export function encodeScheduledChatsCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const o = parsed?.o;
    return Number.isInteger(o) && o >= 0 ? o : null;
  } catch {
    return null;
  }
}

/**
 * Returns null when the caller did not opt into pagination (no `limit`, no
 * `cursor`) so the legacy unpaged response is preserved; otherwise the clamped
 * page, or an error for malformed input.
 */
export function parseScheduledChatsPage(query: any): ScheduledChatsPage | null {
  const rawLimit = query?.limit;
  const rawCursor = query?.cursor;
  if ((rawLimit === undefined || rawLimit === '') && (rawCursor === undefined || rawCursor === '')) {
    return null;
  }

  let limit = SCHEDULED_CHATS_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== '') {
    const n = Number(rawLimit);
    if (typeof rawLimit !== 'string' && typeof rawLimit !== 'number') return { error: 'limit must be a number' };
    if (!Number.isFinite(n)) return { error: 'limit must be a number' };
    limit = Math.min(SCHEDULED_CHATS_MAX_LIMIT, Math.max(1, Math.floor(n)));
  }

  let offset = 0;
  if (rawCursor !== undefined && rawCursor !== '') {
    if (typeof rawCursor !== 'string') return { error: 'cursor is invalid' };
    const decoded = decodeCursor(rawCursor);
    if (decoded === null) return { error: 'cursor is invalid' };
    offset = decoded;
  }

  return { limit, offset };
}
