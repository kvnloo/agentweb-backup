/** Shared by direct Emma handlers and the pre-schema gateway. Never mutates input. */
export function normalizeHubSpotArgs(raw: any): any {
  const args = { ...(raw ?? {}) };
  if (String(args.action ?? '').toUpperCase() === 'LIST_CONTACTS' && !args.entity_type) {
    args.entity_type = 'CONTACTS';
    args.action = 'LIST';
  }
  const entity = String(args.entity_type ?? '').toUpperCase();
  const action = String(args.action ?? '').toUpperCase();
  const scalar = (v: any): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() :
      typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : undefined;
  if (entity === 'CONTACT_LIST' && ['GET', 'LIST'].includes(action)) {
    const query = args.query;
    let queryId: string | undefined;
    let count: any;
    if (query && typeof query === 'object' && !Array.isArray(query)) {
      const keys = Object.keys(query);
      if (keys.every(k => ['listId', 'list_id', 'listid', 'id', 'guid', 'count'].includes(k))) {
        queryId = scalar(query.list_id ?? query.listId ?? query.listid ?? query.id ?? query.guid);
        count = query.count;
      }
    } else if (typeof query === 'string') {
      const match = /^(?:list_?id|id|guid)\s*[=:]\s*["']?(\d+)["']?$/i.exec(query.trim());
      queryId = match?.[1] ?? (action === 'GET' && /^\d+$/.test(query.trim()) ? query.trim() : undefined);
    } else if (action === 'GET') queryId = scalar(query);
    const explicit = scalar(args.list_id);
    const id = explicit ?? scalar(args.listId ?? args.id ?? args.guid) ?? queryId;
    if (id) {
      args.list_id = id;
      args.action = 'GET';
      delete args.listId;
      delete args.id;
      delete args.guid;
      if (!explicit && queryId) {
        delete args.query;
        if (args.count === undefined && count !== undefined) args.count = count;
      }
    }
  }
  if (entity === 'CAMPAIGN' && ['GET', 'GET_METRICS'].includes(action)) {
    const id = scalar(args.guid) ?? scalar(args.id);
    if (id) { args.guid = id; delete args.id; }
  }
  return args;
}
