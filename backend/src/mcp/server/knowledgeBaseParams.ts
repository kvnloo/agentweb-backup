/**
 * ENG-2840 wave 1 (PR C): the knowledge-base list inputs Emma's own tool takes and the MCP wrapper used to drop.
 *
 * `list_knowledge_bases` sent no query at all, although the route behind it (GET /api/emma/knowledge-bases) and Emma's `list_knowledge_base_files` take
 * modified_after, modified_before, limit, offset and kb_type. What each one does is decided by the service (emma/impl/knowledgeBase.ts `listKnowledgeBaseFiles`):
 * kb_type picks the sources ("private" and "public" both mean only the platform knowledge bases, which are not told apart), and the dates, limit and offset
 * apply to the Google Drive files only.
 */

/** The kinds of knowledge base source Emma's list tool can narrow to. */
export const KB_LIST_TYPES = ['google-drive', 'private', 'public', 'clickup', 'clickup-tasks', 'foreplay-swipefile', 'foreplay-board'] as const;

/** Most files one call may ask for (`limit`) and most it may skip (`offset`): the service has no bound, and an unbounded value makes it walk a whole Drive folder. */
export const MAX_KB_LIST_LIMIT = 1_000;
export const MAX_KB_LIST_OFFSET = 100_000;

/** The only date form the service accepts (`validateDriveDateFilter`): a real calendar date, YYYY-MM-DD. */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const refuse = (message: string): never => { throw new Error(`list_knowledge_bases: ${message}`); };

/**
 * Query string for the list call. A model may send a number as text ("50") or leave a value empty; digits-only text is a number and empty means "not given".
 * Anything else that cannot be understood is refused by name instead of being forwarded (the route would turn it into NaN or ignore it).
 */
export function buildKbListQuery(args: any): Record<string, string> {
  const qp: Record<string, string> = {};
  const date = (value: unknown, name: string): void => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') return refuse(`${name} must be text, a date such as 2026-04-15.`);
    const text = value.trim();
    if (text === '') return;
    const m = CALENDAR_DATE.exec(text);
    const real = m && (() => {
      // setUTCFullYear, not Date.UTC: Date.UTC reads the years 0 to 99 as 1900 to 1999.
      const d = new Date(0);
      d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
    })();
    if (!real) return refuse(`${name} must be a calendar date in YYYY-MM-DD form, such as 2026-04-15.`);
    qp[name] = text;
  };
  date(args?.modified_after, 'modified_after');
  date(args?.modified_before, 'modified_before');
  // The two dates are compared as text: YYYY-MM-DD sorts like the dates themselves.
  if (qp.modified_after && qp.modified_before && qp.modified_after > qp.modified_before) {
    return refuse('modified_after must not be later than modified_before (no file could match).');
  }

  const whole = (value: unknown, name: string, max: number): void => {
    if (value === undefined || value === null) return;
    const text = typeof value === 'string' ? value.trim() : undefined;
    const n = text === undefined ? value : text === '' ? 0 : /^\d+$/.test(text) ? Number(text) : NaN;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return refuse(`${name} must be a whole number.`);
    if (n > max) return refuse(`${name} must be ${max} or less.`);
    // 0 means "not given" (the default applies): the service would take a limit of 0 literally and return no file.
    if (n !== 0) qp[name] = String(n);
  };
  whole(args?.limit, 'limit', MAX_KB_LIST_LIMIT);
  whole(args?.offset, 'offset', MAX_KB_LIST_OFFSET);

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

/**
 * ENG-2840 (W2-8): knowledge-base files carry Google Cloud Storage signed links minted to expire in the year 2500 and stored in task
 * records (`knowledgeBase`, `knowledgeBaseFiles[].url`, the listing's `files[].url`). They are bearer links that cannot be revoked short
 * of deleting the file or rotating the storage key, and the listing includes other tenants' public knowledge bases. No MCP tool needs
 * them (`read_knowledge_base_files` reads a file by knowledge base id and file name), so every key whose value is such a signed link is
 * removed from these answers. Everything else is kept as it is.
 */
const SIGNED_STORAGE_LINK = /^https:\/\/([a-z0-9.-]+\.)?storage\.googleapis\.com\/[^\s]*[?&](X-Goog-Signature|Signature)=/i;
const MAX_DEPTH = 40;

export function isSignedStorageLink(value: unknown): boolean {
  return typeof value === 'string' && SIGNED_STORAGE_LINK.test(value.trim());
}

export function withoutSignedStorageLinks<T>(value: T): T {
  // Each object is copied once (a shared or cyclic object maps to the same copy, so no original is ever handed back); anything deeper than
  // MAX_DEPTH is dropped rather than returned unchecked.
  const copies = new WeakMap<object, any>();
  const visit = (v: any, depth: number): any => {
    if (v === null || typeof v !== 'object') return v;
    if (depth > MAX_DEPTH) return undefined;
    const done = copies.get(v);
    if (done !== undefined) return done;
    if (Array.isArray(v)) {
      const out: any[] = [];
      copies.set(v, out);
      for (const item of v) {
        if (isSignedStorageLink(item)) continue;
        const copy = visit(item, depth + 1);
        if (copy !== undefined) out.push(copy);
      }
      return out;
    }
    const out: Record<string, any> = {};
    copies.set(v, out);
    for (const [key, item] of Object.entries(v)) {
      if (isSignedStorageLink(item)) continue;
      const copy = visit(item, depth + 1);
      if (copy !== undefined) out[key] = copy;
    }
    return out;
  };
  return visit(value, 0);
}
