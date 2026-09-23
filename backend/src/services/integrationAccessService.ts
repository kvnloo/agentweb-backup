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
