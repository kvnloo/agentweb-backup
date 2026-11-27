/**
 * ENG-2840 (W2-10): the /api/emma routes behind two MCP reads of the caller's own account: `search_user_assets` and
 * `inspect_linkedin_account` (mcp/server/assetAndOutreachAccountTools.ts).
 *
 * Each route checks the body by name and by value (routes/emmaAssetArgs.ts, the same checks as the MCP tools). No identity is ever read
 * from the body: the only user is `req.user.userId`.
 *
 *  - POST /user-assets runs the same two reads as Emma's `search_user_assets` (emma/tools.ts): the session asset search
 *    (`chatbotDb.searchUserAssets`, the caller's own sessions by UserIdIndex) and the task-run files (`getExecutionsWithAssets`, the
 *    caller's own executions and tasks). Emma's tool runs the second with its defaults, which warm and write session asset caches, fetch
 *    un-enriched report URLs and run a paid report classifier; here it runs with `{ backfill: false, warm: false }`, so the route is a pure
 *    read: nothing is fetched, classified or written. The answer is fixed fields, newest first, at most `limit` items, without session ids.
 *  - POST /linkedin-outreach-account runs Emma's own `inspect_linkedin_account` through Emma's registry, as her dispatcher does, with
 *    `{ userId }` as the only context (the registry adds its evaluation-sandbox check). Emma's tool reads the caller's own user record and
 *    schedules only. Her "not connected" answer repeats the id it was given: here it is a fixed refusal that does not. Fixed fields only.
 *
 * A refusal is HTTP 200 `{ success: false, message }` or a 400 for a bad body; an unexpected failure is a 500 with a fixed text. Budget
 * class: registered on the emmaApi router, after its auth and token-budget middleware.
 */
import type { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { EvaluationDenied, enforceEvaluationTool } from '../services/evaluationPolicy';
import { checkArgs, cut, linkOf, type AssetTool } from './emmaAssetArgs';

export const NO_SUCH_OUTREACH_ACCOUNT_MESSAGE =
  'No LinkedIn Outreach account with that id is connected to your account. Call inspect_linkedin_account without account_id to list yours';

const FAILURE_TEXT: Record<AssetTool, string> = {
  search_user_assets: 'Your assets could not be read',
  inspect_linkedin_account: 'Your LinkedIn Outreach accounts could not be read',
};

function userId(req: Request): string {
  return (req as AuthenticatedRequest).user.userId;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── search_user_assets

type AssetType = 'image' | 'video' | 'htmlReport';
type Found = { url: string; filename: string; assetType: AssetType; generatedAt: string; sessionTitle: string; isFavorited: boolean; approvalStatus?: string };

export type AssetAnswer = {
  url: string;
  filename?: string;
  asset_type: AssetType;
  generated_at?: string;
  session_title?: string;
  is_favorited: boolean;
  approval_status?: string;
};

function shapeAsset(a: Found): AssetAnswer | null {
  const url = linkOf(a.url);
  if (!url) return null;
  const generatedAt = cut(a.generatedAt, 40);
  const approval = cut(a.approvalStatus, 40);
  return {
    url,
    filename: cut(a.filename, 300),
    asset_type: a.assetType,
    ...(generatedAt ? { generated_at: generatedAt } : {}),
    session_title: cut(a.sessionTitle, 300),
    is_favorited: a.isFavorited === true,
    ...(approval ? { approval_status: approval } : {}),
  };
}

/**
 * Emma's search (emma/tools.ts `search_user_assets`), as a pure read for this user only. Session assets first, then (unless only
 * favorites or approved assets are asked for: task files have neither) the files of the caller's own task runs, filtered like Emma's.
 */
async function searchAssets(caller: string, args: Record<string, unknown>): Promise<{ total: number; count: number; assets: AssetAnswer[] }> {
  const { chatbotDb } = await import('../services/chatbotService');
  const { getExecutionsWithAssets } = await import('./tasks');
  const type = args.type as 'images' | 'videos' | 'htmlReports' | 'all' | undefined;
  const query = args.query as string | undefined;
  const favoritesOnly = args.favorites_only === true;
  const approvedOnly = args.approved_only === true;
  const limit = args.limit as number;
  const lowerQuery = query?.toLowerCase();
  const typeFilter = !type || type === 'all' ? null : type;

  const sessionAssets = await chatbotDb.searchUserAssets(caller, type, query, favoritesOnly, approvedOnly);
  const found: Found[] = sessionAssets.map((a) => ({
    url: a.url, filename: a.filename, assetType: a.assetType, generatedAt: a.generatedAt, sessionTitle: a.sessionTitle, isFavorited: a.isFavorited,
    ...(a.approvalStatus !== undefined ? { approvalStatus: a.approvalStatus } : {}),
  }));

  if (!favoritesOnly && !approvedOnly) {
    // As in Emma: with no type (or all) only the task runs' HTML reports are added.
    const taskType = !typeFilter || typeFilter === 'htmlReports' ? 'html-reports' : typeFilter;
    const assetType: AssetType = taskType === 'html-reports' ? 'htmlReport' : taskType === 'images' ? 'image' : 'video';
    const executions = await getExecutionsWithAssets(caller, taskType, '', { backfill: false, warm: false });
    for (const task of Object.values(executions) as any[]) {
      if (task?.source !== 'task') continue;
      for (const execution of task.executions || []) {
        for (const file of execution.result_files || []) {
          const url: string = file?.url || file?.s3_url || '';
          const filename: string = file?.filename || (typeof url === 'string' ? url.split('/').pop() : '') || '';
          if (typeof url !== 'string' || !url || typeof filename !== 'string' || !filename) continue;
          if (lowerQuery && !filename.toLowerCase().includes(lowerQuery) && !url.toLowerCase().includes(lowerQuery)) continue;
          found.push({ url, filename, assetType, generatedAt: execution.startTime || '', sessionTitle: task.taskName || 'Task execution', isFavorited: false });
        }
      }
    }
  }

  const time = (a: Found) => (typeof a.generatedAt === 'string' ? a.generatedAt : '');
  found.sort((a, b) => time(b).localeCompare(time(a)));
  const shaped = found.map(shapeAsset).filter((a): a is AssetAnswer => a !== null);
  const assets = shaped.slice(0, limit);
  return { total: shaped.length, count: assets.length, assets };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── inspect_linkedin_account

function shapeAccount(a: any): Record<string, unknown> {
  return {
    account_id: cut(a?.accountId, 100),
    name: cut(a?.name, 200),
    shared_with_org: a?.sharedWithOrg === true,
    connected_at: cut(a?.connectedAt, 40),
  };
}

function shapeQueuedAction(q: any): Record<string, unknown> {
  return {
    schedule_id: cut(q?.scheduleId, 100),
    action_type: cut(q?.actionType, 60),
    target_type: cut(q?.targetType, 60),
    post_id: cut(q?.postId, 300),
    next_run_time: cut(q?.nextRunTime, 40),
    role: cut(q?.role, 40),
  };
}

/** Emma's own tool through Emma's own registry, as her dispatcher runs it, for this user only. */
async function inspectOutreachAccount(caller: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  await import('../emma/linkedInAccountRevokeTools');
  const { emmaToolRegistry } = await import('../emma/registry');
  const result: any = await emmaToolRegistry.execute('inspect_linkedin_account', args, { userId: caller });
  if (!result || typeof result !== 'object' || !Array.isArray(result.accounts)) throw new Error('inspect_linkedin_account gave no account list');
  // Emma's "not connected to this user" answer repeats the id: a fixed refusal instead.
  if (result.error !== undefined) return { success: false, message: NO_SUCH_OUTREACH_ACCOUNT_MESSAGE };
  const accounts = result.accounts.map(shapeAccount);
  if (args.account_id === undefined) return { success: true, accounts };
  return {
    success: true,
    accounts,
    account_id: args.account_id,
    queued_actions: (Array.isArray(result.queuedActions) ? result.queuedActions : []).map(shapeQueuedAction),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── the routes

function route(router: Router, path: string, tool: AssetTool) {
  router.post(path, async (req: Request, res: Response) => {
    const checked = checkArgs(tool, req.body);
    if (!checked.ok) return res.status(400).json({ message: checked.error });
    const caller = userId(req);
    try {
      if (tool === 'search_user_assets') {
        // Emma's registry runs this check for her own tool; this route reads directly, so it runs it here.
        await enforceEvaluationTool(caller, tool);
        return res.json({ success: true, ...(await searchAssets(caller, checked.args)) });
      }
      res.json(await inspectOutreachAccount(caller, checked.args));
    } catch (err: any) {
      if (err instanceof EvaluationDenied) {
        return res.status(403).json({ message: 'This tool is not available in this sandbox workspace' });
      }
      console.error(`[emma] ${path} failed:`, err?.message);
      res.status(500).json({ message: FAILURE_TEXT[tool] });
    }
  });
}

/** Registers the two routes on the emmaApi router (after its authentication and token-budget middleware). */
export function registerAssetAndOutreachAccountRoutes(router: Router): void {
  route(router, '/user-assets', 'search_user_assets');
  route(router, '/linkedin-outreach-account', 'inspect_linkedin_account');
}
