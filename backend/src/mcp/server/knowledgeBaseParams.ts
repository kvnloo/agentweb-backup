/**
 * ENG-2840 wave 1 (PR C): the knowledge-base inputs Emma's own tools take and the MCP wrappers used to drop.
 *
 * `list_knowledge_bases` sent no query at all, although the route behind it (GET /api/emma/knowledge-bases) and Emma's `list_knowledge_base_files`
 * take modified_after, modified_before, limit, offset and kb_type: a caller could not narrow a large account's list or page through it.
 * `update_knowledge_base_file_content` could only replace a file, while Emma's `update_knowledge_base_file` appends by default.
 */

/** The kinds of knowledge base Emma's list tool can narrow to. */
export const KB_LIST_TYPES = ['google-drive', 'private', 'public', 'clickup', 'clickup-tasks', 'foreplay-swipefile', 'foreplay-board'] as const;

/** Most a file may hold after an append: the per-call limit Emma's own update tool applies. */
export const KB_APPEND_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The separator Emma's append puts between the stored text and the new text (emma/impl/knowledgeBase.ts). */
export const KB_APPEND_SEPARATOR = '\n\n';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const refuse = (message: string): never => { throw new Error(`list_knowledge_bases: ${message}`); };

/**
 * Query string for the list call. A model may send a number as text ("50") or leave a value empty; digits-only text is a number and empty means "not given".
 * Anything else that cannot be understood is refused by name instead of being forwarded (the route would turn it into NaN or ignore it).
 */
export function buildKbListQuery(args: any): Record<string, string> {
  const qp: Record<string, string> = {};
  const date = (value: unknown, name: string): void => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') return refuse(`${name} must be text, an ISO date such as 2026-04-15.`);
    const text = value.trim();
    if (text === '') return;
    if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(text))) return refuse(`${name} must be an ISO date such as 2026-04-15.`);
    qp[name] = text;
  };
  date(args?.modified_after, 'modified_after');
  date(args?.modified_before, 'modified_before');

  const whole = (value: unknown, name: string): void => {
    if (value === undefined || value === null) return;
    const text = typeof value === 'string' ? value.trim() : undefined;
    const n = text === undefined ? value : text === '' ? 0 : /^\d+$/.test(text) ? Number(text) : NaN;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return refuse(`${name} must be a whole number.`);
    // 0 means "not given": a limit of 0 would return nothing, and 0 is the default offset.
    if (n !== 0) qp[name] = String(n);
  };
  whole(args?.limit, 'limit');
  whole(args?.offset, 'offset');

  const type = args?.kb_type;
  if (type !== undefined && type !== null) {
    if (typeof type !== 'string') return refuse(`kb_type must be one of ${KB_LIST_TYPES.join(', ')}.`);
    const wanted = type.trim().toLowerCase();
    if (wanted !== '') {
      if (!(KB_LIST_TYPES as readonly string[]).includes(wanted)) return refuse(`kb_type must be one of ${KB_LIST_TYPES.join(', ')} (got "${type.trim().slice(0, 40)}").`);
      qp.kb_type = wanted;
    }
  }
  return qp;
}
