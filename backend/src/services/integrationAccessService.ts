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

function describe(err: any): string {
  const status = err?.response?.status;
  return status ? `HTTP ${status}` : (err?.message || 'unknown error');
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
