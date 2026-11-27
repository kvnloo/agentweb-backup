/**
 * ENG-2840 (W2-10): `POST /api/emma/kb-file-read`, the route behind the MCP tool `read_knowledge_base_files`
 * (mcp/server/kbFileReadTool.ts). The older `POST /api/emma/read-knowledge-base-files` (emmaApi.ts) is left as it is.
 *
 * It runs Emma's own `readSingleKnowledgeBaseFile` once per entry with `req.user.userId` as the only identity (nothing is read from the
 * body but the two values of each entry), so the tenant checks are Emma's: a knowledge base the caller owns, one an organization member
 * shares with them (per the organization's sharing setting), or one marked public; a Google Drive folder registered by the caller or
 * their organization; the caller's OWN ClickUp and Foreplay connections. Then it maps each result to fixed fields.
 *
 * What it adds to Emma's reader, for outside agents:
 *  - The body is checked by name and by value (shared with the MCP tool): 1 to KB_FILE_READ_MAX_FILES entries, each exactly
 *    `{kb_identifier, file_name}`, the identifier in one of the shapes list_knowledge_bases returns, ids charset-checked.
 *  - `gdoc:<id>` and `gsheet:<id>` are refused: Emma reads those through `readGoogleFileById`, which falls back to the platform's shared
 *    Google service account for ANY file id the caller names (emma/impl/googleDrive.ts). The same files stay readable through their
 *    registered `gdrive:` folder.
 *  - Text only: a file Emma returned as base64 (an image, a video, any binary type she does not parse) is refused as not a text file.
 *  - Each file's text is cut at KB_FILE_READ_MAX_FILE_CHARS and a whole call at KB_FILE_READ_MAX_CALL_CHARS; files past the call limit,
 *    or asked for after KB_FILE_READ_START_WINDOW_MS, are not read and say so.
 *  - A failure is one fixed text per class (KB_FILE_READ_ERRORS). "Not authorized" uses the words of "not found", so the answer never says
 *    whether another account's knowledge base or file exists. No raw exception text, no message of Emma's (they name folders, workspaces,
 *    the service account), no id other than the two the caller sent.
 *
 * A bad body is a 400 `{ message }`; anything unexpected a 500 with a fixed text. Budget class: registered on the emmaApi router, after
 * its auth and token-budget middleware.
 */
import type { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';

// ─────────────────────────────────────────────────────────────────────────────────────────────────── limits

export const KB_FILE_READ_MAX_FILES = 5;
/** Emma's own cut for one file's text over MCP (read_file_content uses the same). */
export const KB_FILE_READ_MAX_FILE_CHARS = 100_000;
export const KB_FILE_READ_MAX_CALL_CHARS = 200_000;
export const KB_FILE_READ_MAX_NAME_CHARS = 255;
/**
 * No new file read starts after this long. One Google Drive read can spend two 90 s folder-walk budgets, and the outside request is cut
 * at 600 s, so the last read that starts still ends in time.
 */
export const KB_FILE_READ_START_WINDOW_MS = 4 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────────── argument checks

export type KbFileEntry = { kb_identifier: string; file_name: string };
export type KbFileReadCheck = { ok: true; files: KbFileEntry[] } | { ok: false; error: string };
export type KbSource = 'agentweb' | 'google_drive' | 'clickup' | 'clickup_tasks' | 'foreplay';

const ENTRY_INPUTS = ['kb_identifier', 'file_name'] as const;
const ID = '[A-Za-z0-9_-]{1,128}';
/** A knowledge base task id: a UUID (Emma, onboarding) or Date.now() digits (tasks created in the portal). */
const TASK_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{10,16})$/i;
const SOURCE_PATTERNS: ReadonlyArray<[RegExp, KbSource]> = [
  [new RegExp(`^gdrive:${ID}$`), 'google_drive'],
  [new RegExp(`^clickup-tasks:${ID}$`), 'clickup_tasks'],
  [new RegExp(`^clickup:${ID}$`), 'clickup'],
  [new RegExp(`^foreplay-board:${ID}$`), 'foreplay'],
  [/^foreplay-swipefile$/, 'foreplay'],
  [TASK_ID_RE, 'agentweb'],
];
const GOOGLE_BY_ID_RE = /^\s*g(?:doc|sheet):/i;
// Control, line-separator, zero-width, word-joiner, bidirectional and byte-order characters: never part of a file name an agent means.
const UNSAFE_NAME_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

const absent = (value: unknown) => value === undefined || value === null;
const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Where an identifier that passed the checks reads from (null for any other shape). */
export function kbSourceOf(kbIdentifier: string): KbSource | null {
  for (const [re, source] of SOURCE_PATTERNS) if (re.test(kbIdentifier)) return source;
  return null;
}

/** The route's body (and the MCP tool's arguments): `files` only, every entry checked by name and by value. Never echoes a value. */
export function checkKbFileReadBody(body: unknown): KbFileReadCheck {
  if (absent(body)) body = {};
  if (!isPlainObject(body)) return { ok: false, error: 'the arguments must be an object' };
  const unknown = Object.keys(body).filter((key) => key !== 'files');
  if (unknown.length > 0) {
    return { ok: false, error: `${unknown.map((k) => `"${k.slice(0, 40)}"`).join(', ')} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'}. The only input is: files` };
  }
  const files = body.files;
  if (!Array.isArray(files)) return { ok: false, error: `files is required: a list of 1 to ${KB_FILE_READ_MAX_FILES} entries, each {kb_identifier, file_name}` };
  if (files.length < 1 || files.length > KB_FILE_READ_MAX_FILES) {
    return { ok: false, error: `files must hold 1 to ${KB_FILE_READ_MAX_FILES} entries (it holds ${files.length})` };
  }
  const out: KbFileEntry[] = [];
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    const at = `files[${i}]`;
    if (!isPlainObject(entry)) return { ok: false, error: `${at} must be an object {kb_identifier, file_name}` };
    const extra = Object.keys(entry).filter((key) => !(ENTRY_INPUTS as readonly string[]).includes(key));
    if (extra.length > 0) {
      return { ok: false, error: `${at}: ${extra.map((k) => `"${k.slice(0, 40)}"`).join(', ')} ${extra.length > 1 ? 'are not inputs' : 'is not an input'}. Each entry takes exactly kb_identifier and file_name` };
    }
    const id = entry.kb_identifier;
    if (typeof id === 'string' && GOOGLE_BY_ID_RE.test(id)) {
      return { ok: false, error: `${at}: a Google Doc or Sheet opened by id (a gdoc: or gsheet: identifier) cannot be read over MCP. Read the file through its Google Drive folder instead: the gdrive: identifier from list_knowledge_bases, with the file's name` };
    }
    if (typeof id !== 'string' || kbSourceOf(id) === null) {
      return { ok: false, error: `${at}: kb_identifier must be an identifier from list_knowledge_bases: a knowledge base id, gdrive:<folder id>, clickup:<workspace id>, clickup-tasks:<workspace id>, foreplay-board:<board id> or foreplay-swipefile` };
    }
    const name = entry.file_name;
    if (typeof name !== 'string' || name.trim() === '' || name.length > KB_FILE_READ_MAX_NAME_CHARS || UNSAFE_NAME_RE.test(name)) {
      return { ok: false, error: `${at}: file_name is required and must be 1 to ${KB_FILE_READ_MAX_NAME_CHARS} characters, with no control or invisible characters` };
    }
    out.push({ kb_identifier: id, file_name: name });
  }
  return { ok: true, files: out };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── answers

export type KbReadErrorClass =
  | 'not_found' | 'not_connected' | 'rate_limited' | 'search_incomplete' | 'ambiguous' | 'not_text' | 'too_large' | 'read_failed' | 'call_limit' | 'out_of_time';

/** The only error texts a file can carry. `not_found` also answers "not authorized". */
export const KB_FILE_READ_ERRORS: Readonly<Record<KbReadErrorClass, string>> = Object.freeze({
  not_found: 'Not found: there is no file with this name in that knowledge base, or you do not have access to it.',
  not_connected: 'This source is not connected to your AgentWeb account. Connect it in Settings, then try again.',
  rate_limited: 'The source is limiting reads right now. Wait a minute, then try again.',
  search_incomplete: 'The search for this file did not finish (part of the Google Drive folder could not be opened, or the folder is too large to search in time), so this is not a confirmed absence. Try again later, or read the file from a smaller folder.',
  ambiguous: 'More than one file in that Google Drive folder has this name. Rename one so the name is unique, then try again.',
  not_text: 'Not a text file: this file is an image, a video or another binary file, and only text can be read here.',
  too_large: 'Too large: this file is over 50 MB, the most that can be read here.',
  read_failed: 'The file could not be read. Try again later.',
  call_limit: `Not read: this call already returned ${KB_FILE_READ_MAX_CALL_CHARS} characters, the most for one call. Read this file in another call.`,
  out_of_time: 'Not read: this call ran out of time before reaching this file. Read it in another call.',
});
const KNOWN_ERROR_TEXTS: ReadonlySet<string> = new Set(Object.values(KB_FILE_READ_ERRORS));

/** One of the fixed error texts, or `read_failed`'s for anything else. */
export function fixedErrorText(value: unknown): string {
  return typeof value === 'string' && KNOWN_ERROR_TEXTS.has(value) ? value : KB_FILE_READ_ERRORS.read_failed;
}

export type KbFileSuccess = KbFileEntry & {
  ok: true;
  knowledge_base_name: string | null;
  source: KbSource;
  content: string;
  content_chars: number;
  truncated: boolean;
  size_bytes: number | null;
  modified_at: string | null;
};
export type KbFileFailure = KbFileEntry & { ok: false; error: string };
export type KbFileResult = KbFileSuccess | KbFileFailure;

export const KB_FILE_SUCCESS_KEYS = ['kb_identifier', 'file_name', 'ok', 'knowledge_base_name', 'source', 'content', 'content_chars', 'truncated', 'size_bytes', 'modified_at'] as const;
export const KB_FILE_FAILURE_KEYS = ['kb_identifier', 'file_name', 'ok', 'error'] as const;

export function kbFailure(entry: KbFileEntry, kind: KbReadErrorClass): KbFileFailure {
  return { kb_identifier: entry.kb_identifier, file_name: entry.file_name, ok: false, error: KB_FILE_READ_ERRORS[kind] };
}

/** The status a provider error carried, when it carried one. */
function statusOf(value: any): number | undefined {
  const status = value?.code ?? value?.status ?? value?.response?.status;
  const n = typeof status === 'string' && /^\d{3}$/.test(status) ? Number(status) : status;
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
}

/**
 * The class of one of Emma's `{ success: false, message, code? }` answers. Her messages are matched only to pick a class; none of their
 * text is passed on. Anything not recognised is `read_failed`.
 */
export function classifyFailure(result: unknown): KbReadErrorClass {
  const r: Record<string, unknown> = isPlainObject(result) ? result : {};
  const message = typeof r.message === 'string' ? r.message : '';
  if (statusOf(r) === 429 || /rate-limited|rate limit/i.test(message)) return 'rate_limited';
  if (/^(ClickUp|Foreplay) not connected$/.test(message)) return 'not_connected';
  if (/^Not authorized to access /.test(message)) return 'not_found';
  if (/^Multiple files named /.test(message)) return 'ambiguous';
  // Drive: the folder (or a sub-folder) could not be opened, the walk stopped at a bound, or the name query itself failed or timed out.
  if (/could not be accessed|not a confirmed absence|^Could not determine whether /.test(message)) return 'search_incomplete';
  // ENG-2840: the Drive text read stops at DRIVE_TEXT_READ_MAX_BYTES (emma/impl/shared/googleDriveAccess.ts).
  if (/is larger than \d+ MB, the most that can be read here/.test(message)) return 'too_large';
  if (/^Failed to read /.test(message)) return 'read_failed';
  if (/not found|does not exist/i.test(message)) return 'not_found';
  return 'read_failed';
}

/** Emma's own cut marker (knowledgeBase.ts): removed, and the text reported as truncated. */
const EMMA_CUT_MARKER = '\n\n[Content truncated due to size limit]';
/** Extensions Emma always turns into text (both her storage and her Google Drive readers): never base64. */
const ALWAYS_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'md', 'html', 'htm', 'csv', 'json', 'xml', 'log', 'pdf', 'xlsx', 'xls', 'xlsm', 'xlsb']);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Whether Emma answered with the file's bytes as base64 (her fallback for a type she does not parse, in AgentWeb storage and Google
 * Drive; ClickUp and Foreplay are always text). Her base64 is one unbroken run of the base64 alphabet, a multiple of 4 long (her
 * 1,000,000-character cut is one too), which real text practically never is; a name with an always-text extension is never refused.
 */
export function isBase64Blob(source: KbSource, fileName: string, content: string): boolean {
  if (source !== 'agentweb' && source !== 'google_drive') return false;
  const dot = fileName.lastIndexOf('.');
  if (dot >= 0 && ALWAYS_TEXT_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase())) return false;
  return content.length >= 4 && content.length % 4 === 0 && BASE64_RE.test(content);
}

/** `text` cut to at most `max` characters, never between the two halves of a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/** A date as a full UTC ISO timestamp, or null. Takes ISO text, epoch milliseconds, or their 13-digit text (ClickUp). */
export function isoOrNull(value: unknown): string | null {
  let ms: number;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && /^\d{13}$/.test(value)) ms = Number(value);
  else if (typeof value === 'string' && value.length <= 40) ms = Date.parse(value);
  else return null;
  if (!Number.isFinite(ms) || ms < 0 || ms > 7_258_118_400_000) return null; // 1970 .. 2200
  return new Date(ms).toISOString();
}

/**
 * One of Emma's answers as fixed fields. `maxChars` is what this file may still return (the per-file cut, or less when the call is near
 * its limit). Only the caller's own two values are echoed; `source` comes from the identifier's shape, not from Emma's `type`.
 */
export function shapeKbReadResult(entry: KbFileEntry, result: unknown, maxChars: number): KbFileResult {
  const source = kbSourceOf(entry.kb_identifier);
  if (!source) return kbFailure(entry, 'read_failed');
  const r = isPlainObject(result) ? result : null;
  if (!r || r.success !== true) return kbFailure(entry, classifyFailure(r));
  const content = r.content;
  if (typeof content !== 'string') return kbFailure(entry, 'read_failed');
  let text = content;
  let truncated = false;
  if (text.endsWith(EMMA_CUT_MARKER)) {
    text = text.slice(0, -EMMA_CUT_MARKER.length);
    truncated = true;
  }
  if (isBase64Blob(source, entry.file_name, text)) return kbFailure(entry, 'not_text');
  const limit = Math.min(KB_FILE_READ_MAX_FILE_CHARS, Math.max(0, maxChars));
  if (text.length > limit) {
    text = cutText(text, limit);
    truncated = true;
  }
  const rawName = r.name;
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? cutText(rawName, 300) : null;
  // Emma's size is the stored file's size in bytes for AgentWeb storage and Google Drive; for ClickUp and Foreplay it is a text length.
  const rawSize = r.size;
  const size = (source === 'agentweb' || source === 'google_drive') && typeof rawSize === 'number' && Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : null;
  return {
    kb_identifier: entry.kb_identifier,
    file_name: entry.file_name,
    ok: true,
    knowledge_base_name: name,
    source,
    content: text,
    content_chars: text.length,
    truncated,
    size_bytes: size,
    modified_at: isoOrNull(r.updatedAt ?? r.modifiedTime ?? r.dateUpdated),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── the route

const FAILURE_TEXT = 'The knowledge base files could not be read';

function userId(req: Request): string {
  return (req as AuthenticatedRequest).user.userId;
}

/** Reads the entries one after another, as the caller, within the call's character and time limits. */
export async function readKbFiles(files: KbFileEntry[], caller: string, now: () => number = Date.now): Promise<{ files: KbFileResult[]; read: number; of: number }> {
  const { readSingleKnowledgeBaseFile } = await import('../emma/impl/knowledgeBase');
  const started = now();
  let remaining = KB_FILE_READ_MAX_CALL_CHARS;
  const results: KbFileResult[] = [];
  for (const entry of files) {
    if (remaining <= 0) { results.push(kbFailure(entry, 'call_limit')); continue; }
    if (now() - started > KB_FILE_READ_START_WINDOW_MS) { results.push(kbFailure(entry, 'out_of_time')); continue; }
    let result: unknown;
    try {
      result = await readSingleKnowledgeBaseFile(entry.kb_identifier, entry.file_name, caller);
    } catch (err: any) {
      console.error('[emma] /kb-file-read: a file read failed:', err?.message);
      results.push(kbFailure(entry, statusOf(err) === 429 ? 'rate_limited' : 'read_failed'));
      continue;
    }
    const shaped = shapeKbReadResult(entry, result, remaining);
    if (shaped.ok) remaining -= shaped.content_chars;
    results.push(shaped);
  }
  return { files: results, read: results.filter((f) => f.ok).length, of: results.length };
}

/** Registers `POST /kb-file-read` on the emmaApi router (after its authentication and token-budget middleware). */
export function registerKbFileReadRoutes(router: Router): void {
  router.post('/kb-file-read', async (req: Request, res: Response) => {
    const checked = checkKbFileReadBody(req.body);
    if (!checked.ok) return res.status(400).json({ message: checked.error });
    try {
      const answer = await readKbFiles(checked.files, userId(req));
      res.json({ success: true, ...answer });
    } catch (err: any) {
      console.error('[emma] /kb-file-read failed:', err?.message);
      res.status(500).json({ message: FAILURE_TEXT });
    }
  });
}
