/**
 * ENG-2118 — read-only "what can Emma reach" inventory for org admins.
 *
 * Walks the ClickUp hierarchy using the connected token's OWN permissions
 * (workspace → space → folder → list, plus docs), so the result reflects what
 * the provider will actually return to Emma — not our KB index. Only ids,
 * names and structure are returned; no task/doc/page content is ever fetched.
 */
import axios from 'axios';
import { listSpaces, listFolders, listDocs, getWorkspaces } from './clickupService';

const CLICKUP_API_V2 = 'https://api.clickup.com/api/v2';

export interface AccessNode {
  id: string;
  name: string;
  type: 'workspace' | 'space' | 'folder' | 'list' | 'doc';
  children?: AccessNode[];
}

export interface ClickUpAccessInventory {
  source: 'clickup';
  connected: boolean;
  identity: { username: string | null; email: string | null } | null;
  checkedAt: string;
  workspaces: AccessNode[];
  errors: string[];
}

async function listLists(accessToken: string, path: string): Promise<AccessNode[]> {
  const response = await axios.get<{ lists: any[] }>(`${CLICKUP_API_V2}/${path}/list?archived=false`, {
    headers: { Authorization: accessToken },
  });
  return (response.data.lists || []).map((l: any) => ({ id: String(l.id), name: String(l.name), type: 'list' as const }));
}

async function getIdentity(accessToken: string): Promise<{ username: string | null; email: string | null } | null> {
  try {
    const response = await axios.get<{ user: any }>(`${CLICKUP_API_V2}/user`, {
      headers: { Authorization: accessToken },
    });
    const u = response.data.user || {};
    return { username: u.username ?? null, email: u.email ?? null };
  } catch {
    return null;
  }
}

/**
 * What goes into a response's `errors[]`. Only the HTTP status or a bare network code ever does: a provider's
 * own message (token-refresh failures, `invalid_grant`, request bodies echoed back) stays in the server log.
 */
function describe(err: any): string {
  const status = err?.response?.status;
  if (status) return `HTTP ${status}`;
  console.warn('[IntegrationAccess] provider call failed:', err?.message || err);
  const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(err.code) ? err.code : null;
  return code ?? 'request failed';
}

export async function buildClickUpAccessInventory(
  accessToken: string | null,
  now: () => Date = () => new Date(),
): Promise<ClickUpAccessInventory> {
  const checkedAt = now().toISOString();
  if (!accessToken) {
    return { source: 'clickup', connected: false, identity: null, checkedAt, workspaces: [], errors: [] };
  }
  const errors: string[] = [];
  const identity = await getIdentity(accessToken);
  const workspaces = await getWorkspaces(accessToken);
  const tree: AccessNode[] = [];
  for (const ws of workspaces) {
    const wsNode: AccessNode = { id: String(ws.id), name: ws.name, type: 'workspace', children: [] };
    try {
      for (const space of await listSpaces(accessToken, ws.id)) {
        const spaceNode: AccessNode = { id: String(space.id), name: space.name, type: 'space', children: [] };
        try {
          for (const folder of await listFolders(accessToken, space.id)) {
            const folderNode: AccessNode = { id: String(folder.id), name: folder.name, type: 'folder', children: [] };
            try {
              folderNode.children = await listLists(accessToken, `folder/${folder.id}`);
            } catch (e) {
              errors.push(`folder ${folder.name}: ${describe(e)}`);
            }
            spaceNode.children!.push(folderNode);
          }
          spaceNode.children!.push(...(await listLists(accessToken, `space/${space.id}`)));
        } catch (e) {
          errors.push(`space ${space.name}: ${describe(e)}`);
        }
        wsNode.children!.push(spaceNode);
      }
    } catch (e) {
      errors.push(`workspace ${ws.name} spaces: ${describe(e)}`);
    }
    try {
      const docs = await listDocs(accessToken, ws.id);
      wsNode.children!.push(...docs.map((d) => ({ id: String(d.id), name: d.name, type: 'doc' as const })));
    } catch (e) {
      errors.push(`workspace ${ws.name} docs: ${describe(e)}`);
    }
    tree.push(wsNode);
  }
  return { source: 'clickup', connected: true, identity, checkedAt, workspaces: tree, errors };
}

// ── Google Drive ────────────────────────────────────────────────────────────

export interface DriveAccessInventory {
  source: 'google_drive';
  connected: boolean;
  identity: { email: string | null } | null;
  checkedAt: string;
  sharedDrives: AccessNode[];
  folders: AccessNode[];
  truncated: boolean;
  errors: string[];
}

/** Minimal slice of the googleapis drive_v3 client this inventory uses. */
export interface DriveListClient {
  drives: { list(params: any): Promise<{ data: { drives?: any[]; nextPageToken?: string } }> };
  files: { list(params: any): Promise<{ data: { files?: any[]; nextPageToken?: string } }> };
}

const DRIVE_FOLDER_CAP = 1000;

/**
 * Lists shared drives and folders (names/ids only) the connected Drive token
 * can see. Never lists file contents or non-folder files.
 */
export async function buildDriveAccessInventory(
  drive: DriveListClient | null,
  email: string | null,
  now: () => Date = () => new Date(),
): Promise<DriveAccessInventory> {
  const checkedAt = now().toISOString();
  const base = { source: 'google_drive' as const, checkedAt, sharedDrives: [] as AccessNode[], folders: [] as AccessNode[], truncated: false, errors: [] as string[] };
  if (!drive) return { ...base, connected: false, identity: null };
  const result: DriveAccessInventory = { ...base, connected: true, identity: { email } };
  try {
    let pageToken: string | undefined;
    do {
      const { data } = await drive.drives.list({ pageSize: 100, pageToken, fields: 'nextPageToken, drives(id, name)' });
      result.sharedDrives.push(...(data.drives || []).map((d: any) => ({ id: String(d.id), name: String(d.name), type: 'workspace' as const })));
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    result.errors.push(`shared drives: ${describe(e)}`);
  }
  try {
    let pageToken: string | undefined;
    do {
      const { data } = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
        pageSize: 200,
        pageToken,
        fields: 'nextPageToken, files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      result.folders.push(...(data.files || []).map((f: any) => ({ id: String(f.id), name: String(f.name), type: 'folder' as const })));
      pageToken = data.nextPageToken;
      if (result.folders.length >= DRIVE_FOLDER_CAP) {
        result.truncated = Boolean(pageToken) || result.folders.length > DRIVE_FOLDER_CAP;
        result.folders = result.folders.slice(0, DRIVE_FOLDER_CAP);
        break;
      }
    } while (pageToken);
  } catch (e) {
    result.errors.push(`folders: ${describe(e)}`);
  }
  return result;
}

// ── Google Drive browser (ENG-2118) ─────────────────────────────────────────
// One folder level at a time, so the whole Drive never loads at once and the
// admin UI can expand folders in place and page through them. Names and ids
// only; no file content is read.

export interface DriveBrowseItem {
  id: string;
  name: string;
  kind: 'folder' | 'file' | 'drive';
  /** Where it comes from, so the UI can tag it: shared with the account, or owned and shared out. */
  shared?: 'with_me' | 'by_me';
}

export interface DriveBrowseResult {
  source: 'google_drive';
  connected: boolean;
  identity: { email: string | null } | null;
  checkedAt: string;
  parent: string | null;
  items: DriveBrowseItem[];
  nextPageToken: string | null;
  errors: string[];
}

export const DRIVE_BROWSE_PAGE_SIZES = [50, 100, 200] as const;
export const DEFAULT_DRIVE_PAGE_SIZE = 50;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHARED_DRIVES_CAP = 500;

export function isValidDriveId(value: unknown): value is string {
  return typeof value === 'string' && DRIVE_ID.test(value);
}

export function clampDrivePageSize(value: unknown): number {
  const n = Number(value);
  return (DRIVE_BROWSE_PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_DRIVE_PAGE_SIZE;
}

function toItem(f: any): DriveBrowseItem {
  const item: DriveBrowseItem = {
    id: String(f.id),
    name: String(f.name),
    kind: f.mimeType === FOLDER_MIME ? 'folder' : 'file',
  };
  if (f.ownedByMe === false) item.shared = 'with_me';
  else if (f.shared === true) item.shared = 'by_me';
  return item;
}

/**
 * Lists one page of one level of the connected Drive. With no `parent` that is
 * the top level: My Drive root plus anything shared with the account, and on the
 * first page the shared drives too. With a `parent` it is that folder's
 * children. `parent` must already be validated.
 */
export async function browseDrive(
  drive: DriveListClient | null,
  email: string | null,
  opts: { parent?: string | null; pageSize?: number; pageToken?: string | null },
  now: () => Date = () => new Date(),
): Promise<DriveBrowseResult> {
  const parent = opts.parent || null;
  const base = {
    source: 'google_drive' as const,
    checkedAt: now().toISOString(),
    parent,
    items: [] as DriveBrowseItem[],
    nextPageToken: null as string | null,
    errors: [] as string[],
  };
  if (!drive) return { ...base, connected: false, identity: null };
  const result: DriveBrowseResult = { ...base, connected: true, identity: { email } };
  const pageSize = clampDrivePageSize(opts.pageSize);
  const pageToken = opts.pageToken || undefined;
  const list = (q: string) => drive.files.list({
    q,
    pageSize,
    pageToken,
    orderBy: 'folder,name',
    fields: 'nextPageToken, files(id, name, mimeType, ownedByMe, shared)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  try {
    if (parent) {
      const { data } = await list(`'${parent}' in parents and trashed=false`);
      result.items = (data.files || []).map(toItem);
      result.nextPageToken = data.nextPageToken || null;
      return result;
    }
    // Top level. Shared drives are few, so they ride along on the first page only.
    if (!pageToken) {
      try {
        let driveToken: string | undefined;
        let fetched = 0;
        do {
          const { data } = await drive.drives.list({ pageSize: 100, pageToken: driveToken, fields: 'nextPageToken, drives(id, name)' });
          result.items.push(...(data.drives || []).map((d: any) => ({ id: String(d.id), name: String(d.name), kind: 'drive' as const })));
          fetched += (data.drives || []).length;
          driveToken = data.nextPageToken;
        } while (driveToken && fetched < SHARED_DRIVES_CAP);
        if (driveToken) result.errors.push(`shared drives: showing the first ${fetched}`);
      } catch (e) {
        result.errors.push(`shared drives: ${describe(e)}`);
      }
    }
    const { data } = await list("('root' in parents or sharedWithMe=true) and trashed=false");
    result.items.push(...(data.files || []).map(toItem));
    result.nextPageToken = data.nextPageToken || null;
  } catch (e) {
    result.errors.push(`${parent ? 'folder' : 'top level'}: ${describe(e)}`);
  }
  return result;
}
