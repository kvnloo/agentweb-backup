import axios from 'axios';

export interface AccessItem {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
}
export interface AccessInventory {
  identity: string | null;
  checkedAt: string;
  items: AccessItem[];
  complete: boolean;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider metadata');
  return value as Record<string, unknown>;
};
const id = (value: unknown): string => {
  if (typeof value === 'string' && value.length > 0 && value.length <= 512) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new Error('Invalid provider ID');
};
const name = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid provider name');
  return value;
};

/** Metadata only. Never log provider errors: axios errors contain authorization headers.
 * Limits bound pagination, response bytes, memory and wall time for every source.
 */
export async function inspectSource(provider: 'clickup' | 'google_drive', token: string): Promise<AccessInventory> {
  const result: AccessInventory = { identity: null, checkedAt: '', items: [], complete: true };
  const deadline = Date.now() + 20000;
  let requests = 0;
  const seen = new Set<string>();
  const get = async (url: string, params: Record<string, string | number | boolean> = {}) => {
    if (++requests > 80 || Date.now() >= deadline || result.items.length >= 2000) throw new Error('Inventory limit');
    const response = await axios.get<unknown>(url, {
      params, headers: { Authorization: provider === 'clickup' ? token : `Bearer ${token}` },
      timeout: Math.min(5000, deadline - Date.now()), maxContentLength: 2 * 1024 * 1024,
      maxRedirects: 0,
    });
    return object(response.data);
  };
  const rows = (data: Record<string, unknown>, key: string): Record<string, unknown>[] => {
    if (!Array.isArray(data[key])) throw new Error('Invalid provider collection');
    return (data[key] as unknown[]).map(object);
  };
  const children = async (url: string, key: string, params: Record<string, string | number | boolean> = {}) => {
    try { return rows(await get(url, params), key); }
    catch { result.complete = false; return []; }
  };
  const add = (raw: Record<string, unknown>, kind: string, parentId: string | null, prefix = '') => {
    const rawId = id(raw.id);
    const itemId = `${prefix}${rawId}`;
    if (result.items.length >= 2000) throw new Error('Inventory limit');
    const item = { id: rawId, name: name(raw.name), kind, parentId };
    // Prefix disambiguates ClickUp's independent numeric ID namespaces.
    if (!seen.has(itemId)) { result.items.push(item); seen.add(itemId); }
    return `${kind}:${rawId}`;
  };
  const page = async (url: string, key: string, params: Record<string, string | number | boolean>, visit: (row: Record<string, unknown>) => void) => {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const data = await get(url, { ...params, ...(cursor ? { [provider === 'clickup' ? 'cursor' : 'pageToken']: cursor } : {}) });
      for (const row of rows(data, key)) visit(row);
      if (data.incompleteSearch === true) result.complete = false;
      const next = data[provider === 'clickup' ? 'next_cursor' : 'nextPageToken'];
      cursor = next === undefined || next === null || next === '' ? undefined : id(next);
      if (cursor && cursors.has(cursor)) throw new Error('Repeated provider cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  };
  try {
    if (provider === 'google_drive') {
      const about = await get('https://www.googleapis.com/drive/v3/about', { fields: 'user(emailAddress,displayName)' });
      const user = object(about.user);
      result.identity = name(user.emailAddress ?? user.displayName);
      await page('https://www.googleapis.com/drive/v3/files', 'files', {
        q: 'trashed = false', pageSize: 100, spaces: 'drive', corpora: 'allDrives',
        includeItemsFromAllDrives: true, supportsAllDrives: true,
        fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,parents)',
      }, row => {
        if (typeof row.mimeType !== 'string') throw new Error('Invalid file type');
        if (row.parents !== undefined && (!Array.isArray(row.parents) || row.parents.some(p => typeof p !== 'string'))) throw new Error('Invalid parents');
        add(row, row.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
          Array.isArray(row.parents) && row.parents.length ? `folder:${id(row.parents[0])}` : null);
      });
    } else {
      const v2 = 'https://api.clickup.com/api/v2';
      const v3 = 'https://api.clickup.com/api/v3';
      const user = object((await get(`${v2}/user`)).user);
      result.identity = name(user.email ?? user.username);
      for (const team of rows(await get(`${v2}/team`), 'teams')) {
        const teamKey = add(team, 'workspace', null, 'workspace:');
        const teamId = encodeURIComponent(id(team.id));
        for (const archived of [false, true]) {
          for (const space of await children(`${v2}/team/${teamId}/space`, 'spaces', { archived })) {
            const spaceKey = add(space, 'space', teamKey, 'space:');
            const spaceId = encodeURIComponent(id(space.id));
            for (const childArchived of [false, true]) {
              for (const folder of await children(`${v2}/space/${spaceId}/folder`, 'folders', { archived: childArchived })) {
                const folderKey = add(folder, 'folder', folder.parent_folder == null ? spaceKey : `folder:${id(folder.parent_folder)}`, 'folder:');
                // Keep embedded lists even if a later per-folder request is denied/capped.
                if (folder.lists !== undefined) {
                  for (const list of rows(folder, 'lists')) add(list, 'list', folderKey, 'list:');
                }
                for (const listArchived of [false, true]) {
                  for (const list of await children(`${v2}/folder/${encodeURIComponent(id(folder.id))}/list`, 'lists', { archived: listArchived })) {
                    add(list, 'list', folderKey, 'list:');
                  }
                }
              }
              for (const list of await children(`${v2}/space/${spaceId}/list`, 'lists', { archived: childArchived })) {
                add(list, 'list', spaceKey, 'list:');
              }
            }
          }
          try { await page(`${v3}/workspaces/${teamId}/docs`, 'docs', { limit: 100, archived, deleted: false }, doc => {
            let parent = teamKey;
            if (doc.parent != null) {
              const p = object(doc.parent);
              const parentKinds: Record<string, string> = { '4': 'space', '5': 'folder', '6': 'list', '12': 'workspace' };
              const kind = parentKinds[String(p.type)] ?? (typeof p.type === 'string' ? p.type.toLowerCase() : '');
              if (['space', 'folder', 'list', 'doc'].includes(kind)) parent = `${kind}:${id(p.id)}`;
            }
            add(doc, 'doc', parent, 'doc:');
          }); } catch { result.complete = false; }
        }
      }
    }
  } catch {
    result.complete = false;
  }
  result.checkedAt = new Date().toISOString();
  return result;
}
