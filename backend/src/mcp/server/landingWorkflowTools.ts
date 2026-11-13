/**
 * Landing-page Workflow Tools — tranche 2 of the job-shaped MCP surface
 * (ENG-1004, child of ENG-463; tranche 1 was ENG-982 in workflowTools.ts).
 *
 * The heaviest orchestration in the whole set: ~11 granular landing-page
 * tools collapse into 2. Same design rules as tranche 1:
 *   - `emma_` prefix, verb + object, named for the OUTCOME. No `manage_*`,
 *     no `action:` enum.
 *   - descriptions say when NOT to use the tool.
 *   - every call goes through the JWT-authed REST layer via `mcpFetch`,
 *     exactly as apiTools.ts does. No direct service calls, so the IDOR
 *     boundary and ENG-973's quota gate both still apply.
 *   - `requiresUserAccount: true` on both — these generate/deploy/publish
 *     billable, customer-visible pages.
 *   - generation cost: `generate_landing_page` is the single most expensive
 *     tool on the surface (v0 generation + Vercel deploy). The quota check
 *     fires inside the REST layer before generation starts, so an over-quota
 *     caller is refused before we pay v0 — this layer adds no bypass.
 *
 * Additive only: this file registers new tools and removes nothing. Unlisting
 * the granular catalogue behind tool search is ENG-983.
 */

import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';

/** The reusable staging branch preview deployments build from. */
const PREVIEW_BRANCH = 'draft/agentweb-preview';

// ─── 1. Generate + deploy a live landing page ───────────────────────────────

mcpToolRegistry.register({
  name: 'emma_create_landing_page',
  requiresUserAccount: true,
  definition: {
    name: 'emma_create_landing_page',
    description:
      'Generate and deploy a live landing page from a description, using this account\'s brand guidelines. Returns the live URL. ' +
      'One call generates, waits for deployment to reach a terminal state, and returns a URL that resolves — never an intermediate id to poll with another tool. ' +
      'Do NOT use this to tweak an existing page — use emma_edit_landing_page for revisions. ' +
      'A failed deploy is reported as failed with the reason, not as a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'What the page should say and show — offer, sections, tone. Brand colors/fonts come from the account automatically.',
        },
        name: { type: 'string', description: 'Page name, used for the site title.' },
        lead_list_id: {
          type: 'string',
          description: 'Optional lead-list id for the contact form. Omit to use the default list.',
        },
      },
      required: ['description', 'name'],
    },
  },
  execute: async (args: any, context: any) => {
    const generated: any = await mcpFetch({
      method: 'POST',
      path: '/api/landing-pages/v0/generate',
      context: ctx(context),
      body: {
        prompt: args?.description,
        name: args?.name,
        ...(args?.lead_list_id ? { lead_list_id: args.lead_list_id } : {}),
      },
    });
    const pageId = generated?.id;
    if (!pageId) {
      return jsonResult({ status: 'failed', url: null, error: 'Generation did not return a page id.' });
    }
    // The job is generate → confirm deployment succeeded → return a URL the
    // caller can actually open. The status check happens inside this call so
    // the agent never has to chase an intermediate id with a second tool.
    const status: any = await mcpFetch({
      method: 'GET',
      path: `/api/landing-pages/v0/generated/${encodeURIComponent(pageId)}/deployment-status`,
      context: ctx(context),
    });
    if (status?.status === 'deployed' && status?.deployedUrl) {
      return jsonResult({ status: 'deployed', url: status.deployedUrl, page_id: pageId, launch_readiness: status?.launchReadiness ?? null });
    }
    const reason =
      status?.buildError ??
      (Array.isArray(status?.launchReadiness?.reasons) ? status.launchReadiness.reasons.join('; ') : null) ??
      `deployment status: ${status?.status ?? 'unknown'}`;
    return jsonResult({ status: 'failed', url: null, page_id: pageId, error: reason });
  },
});

// ─── 2. Revise a live page: preview in one call, publish only when asked ────

mcpToolRegistry.register({
  name: 'emma_edit_landing_page',
  requiresUserAccount: true,
  definition: {
    name: 'emma_edit_landing_page',
    description:
      'Revise a live landing page with plain-language instructions, preview the change, then publish or roll back. ' +
      'One call revises and returns the preview URL; nothing goes live unless publish is explicitly true. ' +
      'Do NOT use this to create a new page — use emma_create_landing_page for that. ' +
      'Pass revert_last_publish true (and nothing else) to undo the most recent publish.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The landing page id.' },
        instructions: { type: 'string', description: 'What to change, in plain language.' },
        branch: {
          type: 'string',
          description: 'Draft branch to revise on. Defaults to the shared preview branch.',
        },
        publish: {
          type: 'boolean',
          description: 'Publish to production after preview. Defaults to false — preview only.',
        },
        revert_last_publish: {
          type: 'boolean',
          description: 'Undo the most recent publish instead of revising. Ignores instructions/publish.',
        },
      },
      required: ['page_id'],
    },
  },
  execute: async (args: any, context: any) => {
    const pageId = args?.page_id;
    const encodedPageId = encodeURIComponent(pageId);
    if (args?.revert_last_publish === true) {
      const reverted: any = await mcpFetch({
        method: 'POST',
        path: `/api/landing-pages/v0/generated/${encodedPageId}/revert-publish`,
        context: ctx(context),
      });
      return jsonResult({ reverted: true, page_id: pageId, message: reverted?.message ?? null });
    }
    if (typeof args?.instructions !== 'string' || args.instructions.trim() === '') {
      return jsonResult({
        status: 'failed',
        url: null,
        page_id: pageId ?? null,
        error: 'instructions is required unless revert_last_publish is true — nothing was revised.',
      });
    }
    await mcpFetch({
      method: 'POST',
      path: `/api/landing-pages/v0/generated/${encodedPageId}/iterate`,
      context: ctx(context),
      body: { instructions: args?.instructions, branch: args?.branch ?? PREVIEW_BRANCH },
    });
    const branch = args?.branch ?? PREVIEW_BRANCH;
    const preview: any = await mcpFetch({
      method: 'GET',
      path: `/api/landing-pages/v0/generated/${encodedPageId}/preview-url?branch=${encodeURIComponent(branch)}`,
      context: ctx(context),
    });
    const previewUrl = preview?.previewUrl ?? preview?.preview_url ?? null;
    if (args?.publish === true) {
      const published: any = await mcpFetch({
        method: 'POST',
        path: `/api/landing-pages/v0/generated/${encodedPageId}/publish`,
        context: ctx(context),
        body: { branch },
      });
      return jsonResult({
        published: true,
        page_id: pageId,
        preview_url: previewUrl,
        url: published?.deployed_url ?? published?.deployedUrl ?? null,
      });
    }
    return jsonResult({ published: false, page_id: pageId, preview_url: previewUrl });
  },
});

/** Names registered by this layer — exported so tests can assert the set. */
export const LANDING_WORKFLOW_TOOL_NAMES = [
  'emma_create_landing_page',
  'emma_edit_landing_page',
] as const;
