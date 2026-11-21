/** Shared by direct Emma handlers and the pre-schema gateway. Never mutates input. */
export function normalizeHubSpotArgs(raw: any): any {
  const args = { ...(raw ?? {}) };
  // ENG-2792: models send lowercase enums and raw-REST shapes ({endpoint, method}).
  if (typeof args.entity_type === 'string') args.entity_type = args.entity_type.trim().toUpperCase();
  if (typeof args.action === 'string') args.action = args.action.trim().toUpperCase();
  if (!args.entity_type && typeof args.endpoint === 'string') {
    const entity = hubSpotEntityFromEndpoint(args.endpoint);
    const method = typeof args.method === 'string' ? args.method.trim().toUpperCase() : 'GET';
    if (entity && (args.action || method === 'GET')) {
      args.entity_type = entity;
      // DEALS has no LIST action; a bare collection GET means "search deals".
      if (!args.action) args.action = entity === 'DEALS' ? 'SEARCH' : 'LIST';
      delete args.endpoint;
      delete args.method;
    }
  }
  // CONTACTS supports LIST only; a bare GET with no id means "list contacts".
  if (args.entity_type === 'CONTACTS' && args.action === 'GET' && args.id === undefined) args.action = 'LIST';
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

const HUBSPOT_ENDPOINT_ENTITIES: Array<[RegExp, string]> = [
  [/(^|\/)contacts?$/, 'CONTACTS'],
  [/(^|\/)deals?$/, 'DEALS'],
  [/(^|\/)campaigns?$/, 'CAMPAIGN'],
  [/(^|\/)(lists?|contact_lists?)$/, 'CONTACT_LIST'],
  [/(^|\/)emails?$/, 'EMAIL'],
  [/(^|\/)forms?$/, 'FORM'],
  [/(^|\/)landing[-_]pages?$/, 'LANDING_PAGE'],
  [/(^|\/)(blog[-_]?)?posts?$/, 'BLOG_POST'],
  [/(^|\/)(workflows?|flows?)$/, 'WORKFLOW'],
];

/** Map a collection endpoint (e.g. "/crm/v3/objects/contacts?limit=5") to an entity_type. */
function hubSpotEntityFromEndpoint(endpoint: string): string | undefined {
  const path = endpoint.trim().toLowerCase().split(/[?#]/)[0].replace(/\/+$/, '');
  return HUBSPOT_ENDPOINT_ENTITIES.find(([re]) => re.test(path))?.[1];
}
