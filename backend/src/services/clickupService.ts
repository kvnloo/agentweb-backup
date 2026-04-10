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

export interface ClickUpSpace {
  id: string;
  name: string;
}

export interface ClickUpFolder {
  id: string;
  name: string;
}

export interface ClickUpDoc {
  id: string;
  name: string;
  dateCreated: string;
  dateUpdated: string;
}

export interface ClickUpAttachment {
  id: string;
  title: string;
  url: string;
  size?: number;
}

export interface ClickUpTask {
  id: string;
  name: string;
  description: string;
  status: string;
  assignees: string[];
  dueDate: string | null;
  tags: string[];
  priority: string | null;
  attachments: ClickUpAttachment[];
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

/**
 * Map a raw ClickUp API task object to our ClickUpTask interface.
 */
function mapTask(task: any): ClickUpTask {
  return {
    id: task.id,
    name: task.name,
    description: task.description || '',
    status: task.status?.status || '',
    assignees: (task.assignees || []).map((a: any) => a.username || a.email || ''),
    dueDate: task.due_date || null,
    tags: (task.tags || []).map((t: any) => t.name || ''),
    priority: task.priority?.priority || null,
    attachments: (task.attachments || []).map((att: any) => ({
      id: att.id,
      title: att.title || '',
      url: att.url,
      size: att.size,
    })),
    dateCreated: task.date_created,
    dateUpdated: task.date_updated || task.date_created,
  };
}

/**
 * Fetch a single task by ID (returns full details including attachments).
 */
export async function getTask(accessToken: string, taskId: string): Promise<ClickUpTask> {
  const headers = { Authorization: accessToken };
  const response = await axios.get<any>(
    `${CLICKUP_API_V2}/task/${taskId}`,
    { headers }
  );
  return mapTask(response.data);
}

/**
 * List all tasks in a workspace (paginated via v2 API).
 * Enriches each task with attachment data from individual task fetches,
 * since the list endpoint may not include attachments.
 */
export async function listTasks(accessToken: string, teamId: string): Promise<ClickUpTask[]> {
  const allTasks: any[] = [];
  let page = 0;
  const headers = { Authorization: accessToken };
  let lastPage = false;
  do {
    const params = new URLSearchParams({ page: String(page) });
    const response = await axios.get<{ tasks: any[]; last_page: boolean }>(
      `${CLICKUP_API_V2}/team/${teamId}/task?${params.toString()}`,
      { headers }
    );
    allTasks.push(...(response.data.tasks || []));
    lastPage = response.data.last_page !== false;
    page++;
  } while (!lastPage);

  const mapped = allTasks.map(mapTask);

  // Enrich tasks that have no attachments from the list response
  // by fetching individual task details (the single-task endpoint returns attachments).
  // Process in batches of 10 to avoid overwhelming the API.
  const BATCH_SIZE = 10;
  for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
    const batch = mapped.slice(i, i + BATCH_SIZE);
    const enriched = await Promise.all(
      batch.map(async (task) => {
        if (task.attachments.length > 0) return task; // already has attachment data
        try {
          const full = await getTask(accessToken, task.id);
          task.attachments = full.attachments;
        } catch {
          // Keep task without attachments if individual fetch fails
        }
        return task;
      })
    );
    // Replace in-place
    for (let j = 0; j < enriched.length; j++) {
      mapped[i + j] = enriched[j];
    }
  }

  return mapped;
}

/**
 * List all spaces in a workspace.
 */
export async function listSpaces(accessToken: string, workspaceId: string): Promise<ClickUpSpace[]> {
  const response = await axios.get<{ spaces: any[] }>(
    `${CLICKUP_API_V2}/team/${workspaceId}/space?archived=false`,
    { headers: { Authorization: accessToken } }
  );
  return (response.data.spaces || []).map((space: any) => ({
    id: space.id,
    name: space.name,
  }));
}

/**
 * List all non-archived folders in a space.
 */
export async function listFolders(accessToken: string, spaceId: string): Promise<ClickUpFolder[]> {
  const response = await axios.get<{ folders: any[] }>(
    `${CLICKUP_API_V2}/space/${spaceId}/folder?archived=false`,
    { headers: { Authorization: accessToken } }
  );
  return (response.data.folders || []).map((folder: any) => ({
    id: folder.id,
    name: folder.name,
  }));
}

/**
 * Create a new doc in a workspace. Optionally place it under a parent folder.
 * parentType: 4=folder, 5=list, 6=task, 7=workspace (default: workspace root)
 */
export async function createDoc(
  accessToken: string,
  workspaceId: string,
  name: string,
  content: string,
  parentId?: string,
  parentType?: number
): Promise<{ id: string; name: string }> {
  const body: any = { name, content };
  if (parentId) {
    body.parent = { id: parentId, type: parentType ?? 4 };
  }
  const response = await axios.post<{ id: string; name: string }>(
    `${CLICKUP_API_V3}/workspaces/${workspaceId}/docs`,
    body,
    { headers: { Authorization: accessToken, 'Content-Type': 'application/json' } }
  );
  return { id: response.data.id, name: response.data.name };
}

/**
 * Update (edit) an existing page in a doc.
 */
export async function editPage(
  accessToken: string,
  workspaceId: string,
  docId: string,
  pageId: string,
  content: string
): Promise<void> {
  await axios.put(
    `${CLICKUP_API_V3}/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`,
    { content },
    { headers: { Authorization: accessToken, 'Content-Type': 'application/json' } }
  );
}

/**
 * Read a single task and format it as markdown.
 */
export async function readTaskContent(accessToken: string, taskId: string): Promise<string> {
  const task = await getTask(accessToken, taskId);

  const parts: string[] = [];
  parts.push(`# ${task.name}`);
  parts.push('');

  // Metadata
  if (task.status) {
    parts.push(`**Status:** ${task.status}`);
  }
  if (task.priority) {
    parts.push(`**Priority:** ${task.priority}`);
  }
  if (task.assignees.length > 0) {
    parts.push(`**Assignees:** ${task.assignees.join(', ')}`);
  }
  if (task.dueDate) {
    const dueDate = new Date(parseInt(task.dueDate, 10));
    parts.push(`**Due Date:** ${dueDate.toISOString().split('T')[0]}`);
  }
  if (task.tags.length > 0) {
    parts.push(`**Tags:** ${task.tags.join(', ')}`);
  }

  // Description
  if (task.description.trim()) {
    parts.push('');
    parts.push('## Description');
    parts.push('');
    parts.push(task.description);
  }

  // Attachments
  if (task.attachments.length > 0) {
    parts.push('');
    parts.push('## Attachments');
    parts.push('');
    for (const att of task.attachments) {
      const sizeStr = att.size ? ` (${att.size} bytes)` : '';
      parts.push(`- [${att.title || 'Untitled'}](${att.url})${sizeStr}`);
    }
  }

  return parts.join('\n');
}
