import axios from 'axios';
import { userDb } from './db';
import { decryptPassword } from '../utils/crypto';

const CLICKUP_API_V2 = 'https://api.clickup.com/api/v2';
const CLICKUP_API_V3 = 'https://api.clickup.com/api/v3';

export interface ClickUpWorkspace {
  id: string;
  name: string;
  avatar?: string | null;
}

export interface ClickUpDoc {
  id: string;
  name: string;
  dateCreated: string;
  dateUpdated: string;
}

/**
 * Get the decrypted ClickUp access token for a user.
 * Returns null if no token is stored or decryption fails.
 */
export async function getAccessToken(userId: string): Promise<string | null> {
  const user = await userDb.getUserById(userId);
  const secrets = (user?.secrets as Record<string, string>) || {};
  if (!secrets.clickup_access_token) return null;
  try {
    const decrypted = decryptPassword(secrets.clickup_access_token);
    return decrypted.password;
  } catch {
    return null;
  }
}

/**
 * Fetch workspaces (teams) the token has access to.
 */
export async function getWorkspaces(accessToken: string): Promise<ClickUpWorkspace[]> {
  const response = await axios.get<{ teams: any[] }>(`${CLICKUP_API_V2}/team`, {
    headers: { Authorization: accessToken },
  });
  return (response.data.teams || []).map((team: any) => ({
    id: team.id,
    name: team.name,
    avatar: team.avatar || null,
  }));
}

/**
 * List all non-deleted, non-archived docs in a workspace (paginated).
 */
export async function listDocs(accessToken: string, workspaceId: string): Promise<ClickUpDoc[]> {
  const allDocs: any[] = [];
  let cursor: string | undefined;
  const headers = { Authorization: accessToken };
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const response = await axios.get<{ docs: any[]; next_cursor?: string }>(
      `${CLICKUP_API_V3}/workspaces/${workspaceId}/docs?${params.toString()}`,
      { headers }
    );
    allDocs.push(...(response.data.docs || []));
    cursor = response.data.next_cursor || undefined;
  } while (cursor);

  return allDocs
    .filter((doc: any) => !doc.deleted && !doc.archived)
    .map((doc: any) => ({
      id: doc.id,
      name: doc.name,
      dateCreated: doc.date_created,
      dateUpdated: doc.date_updated || doc.date_created,
    }));
}

/**
 * Read a doc's content by fetching all its pages and concatenating them.
 */
export async function readDocContent(accessToken: string, workspaceId: string, docId: string): Promise<string> {
  const headers = { Authorization: accessToken };

  // Step 1: List all pages in the doc
  const listResponse = await axios.get<any>(
    `${CLICKUP_API_V3}/workspaces/${workspaceId}/docs/${docId}/pages`,
    { headers }
  );
  // The v3 API returns a raw array, not { pages: [...] }
  const pagesList: any[] = Array.isArray(listResponse.data)
    ? listResponse.data
    : (listResponse.data.pages || listResponse.data.data || []);

  // Step 2: For each page, fetch individual page to get content
  const contentParts: string[] = [];
  for (const pageSummary of pagesList) {
    const pageId = pageSummary.id;
    if (!pageId) continue;

    let pageTitle = pageSummary.name || pageSummary.title || '';
    let pageContent = pageSummary.content || '';

    // If content is empty from the list, fetch individual page
    if (!pageContent && pageId) {
      try {
        const pageResponse = await axios.get<any>(
          `${CLICKUP_API_V3}/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`,
          { headers }
        );
        const pageData = pageResponse.data as any;
        pageContent = pageData.content || pageData.body || '';
        if (!pageTitle) pageTitle = pageData.name || pageData.title || '';
      } catch {
        // Skip pages that fail to fetch individually
      }
    }

    if (pageTitle || pageContent) {
      contentParts.push(pageTitle ? `# ${pageTitle}\n\n${pageContent}` : pageContent);
    }
  }
  return contentParts.join('\n\n---\n\n');
}
