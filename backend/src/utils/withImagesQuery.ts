// ENG-2386: optional server-side filter + pagination for
// GET /api/tasks/executions/with-images. Pure post-processing over the existing
// grouped result; when no params are given the result is returned unchanged.

export interface WithImagesQuery {
  favorites: boolean;
  approved: boolean;
  limit?: number;
  cursor: number;
}

export const WITH_IMAGES_MAX_LIMIT = 200;

interface AssetFile { url?: string; is_favorited?: boolean; [k: string]: unknown }
interface AssetExecution { result_files?: AssetFile[]; [k: string]: unknown }
export interface AssetTask { executions?: AssetExecution[]; latestExecutionTime?: string | null; [k: string]: unknown }

function truthy(v: unknown): boolean {
  return v === 'true' || v === '1' || v === true;
}

/** Parse req.query. Returns null when no filtering/paging params are present. */
export function parseWithImagesQuery(query: Record<string, unknown>): WithImagesQuery | { error: string } | null {
  const favorites = truthy(query.favorites);
  const approved = truthy(query.approved);
  const hasLimit = query.limit !== undefined;
  const hasCursor = query.cursor !== undefined;
  const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';
  if (hasLimit && blank(query.limit)) return { error: 'limit must be a positive integer' };
  if (hasCursor && blank(query.cursor)) return { error: 'cursor must be a non-negative integer' };
  if (!favorites && !approved && !hasLimit && !hasCursor) return null;

  let limit: number | undefined;
  if (hasLimit) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1) return { error: 'limit must be a positive integer' };
    limit = Math.min(limit, WITH_IMAGES_MAX_LIMIT);
  }
  let cursor = 0;
  if (hasCursor) {
    cursor = Number(query.cursor);
    if (!Number.isInteger(cursor) || cursor < 0) return { error: 'cursor must be a non-negative integer' };
  }
  return { favorites, approved, limit, cursor };
}

/**
 * Filter files (favorites / approved), drop tasks left with no files, order
 * tasks newest-execution first (the portal's default sort), then slice
 * `limit` tasks starting at `cursor`. Returns the filtered map plus the next
 * cursor (null when exhausted).
 */
export function applyWithImagesQuery(
  result: Record<string, AssetTask>,
  q: WithImagesQuery,
  approvalStatusByUrl: Record<string, string | undefined> = {},
): { tasks: Record<string, AssetTask>; nextCursor: number | null; total: number } {
  const keepFile = (file: AssetFile): boolean => {
    if (q.favorites && !file?.is_favorited) return false;
    if (q.approved && approvalStatusByUrl[file?.url ?? ''] !== 'approved') return false;
    return true;
  };
  const filtering = q.favorites || q.approved;

  const entries: Array<[string, AssetTask]> = [];
  for (const [taskId, task] of Object.entries(result)) {
    if (!filtering) {
      entries.push([taskId, task]);
      continue;
    }
    const executions = (task.executions || [])
      .map((exec) => ({ ...exec, result_files: (exec.result_files || []).filter(keepFile) }))
      .filter((exec) => exec.result_files.length > 0);
    if (executions.length > 0) entries.push([taskId, { ...task, executions }]);
  }

  entries.sort(([aId, a], [bId, b]) => {
    const cmp = (b.latestExecutionTime || '').localeCompare(a.latestExecutionTime || '');
    return cmp !== 0 ? cmp : aId.localeCompare(bId);
  });

  const total = entries.length;
  const end = q.limit === undefined ? total : Math.min(total, q.cursor + q.limit);
  const page = entries.slice(q.cursor, end);
  return {
    tasks: Object.fromEntries(page),
    nextCursor: end < total ? end : null,
    total,
  };
}
