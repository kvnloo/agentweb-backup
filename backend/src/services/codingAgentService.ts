/**
 * Coding Agent Service
 *
 * A sub-agent that Emma delegates to for code editing tasks.
 * Uses the Anthropic SDK with AWS Bedrock for the agentic loop.
 * Runs with diff-based editing tools, reads files before editing,
 * checks deployment after changes, and iterates on build errors.
 */

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { mcpFetch } from '../mcp/server/httpClient';
import { agentModeService } from './agentModeService';
import { getGitHubOrgToken, getSecret } from '../utils/secretsManager';
import { recordUsage, computeCostMicroUsd } from './usageRecorderService';
import { getLandingPageById, getLandingPagesByOwner, canUserEditLandingPage, GeneratedLandingPage } from './v0Service';
import { AcceptanceCheck, AcceptanceStatus, AcceptanceVerificationResult, verifyAcceptanceChecks } from './codingAgentAcceptance';
import {
  CodingAgentRecoveryState,
  CodingAgentRunState,
  createCodingAgentRun,
  updateCodingAgentRun,
} from './codingAgentRunService';

// ─── Types ──────────────────────────────────────────────────────────────────

export const LANDING_PAGE_PREVIEW_BRANCH = 'draft/agentweb-preview';

const GITHUB_API_TIMEOUT_MS = 30_000;

/**
 * The repo a coding-agent run edits. Many landing pages share ONE GitHub repo —
 * each page is an `app/<slug>/` route directory (plus the root page, which owns
 * the top-level `app/` files). A run keyed on one pageId may be just one route of
 * such a multi-route project, and the file API is already confined to that one
 * repo, so the whole repo is editable. The safety guard `isSafeRepoPath` only
 * blocks paths that escape the repo.
 */
export interface PageScope {
  /** The GitHub repo this run edits. The coding agent's file API is already
   * confined to this one repo, so the editable boundary is the whole repo. */
  repoUrl: string;
  /** Slugs of all route directories (app/<slug>/) in this repo — informational,
   * surfaced to the agent so it knows which sibling routes share the project. */
  routeSlugs: string[];
}

export interface CodingAgentContext {
  pageId: string;
  userId: string;
  sessionId: string;
  llmModel: string;
  /** Draft branch name for staging edits. Defaults upstream to LANDING_PAGE_PREVIEW_BRANCH. If unset, edits go to main. */
  draftBranch?: string;
  /**
   * Editable file boundary for this run. Resolved from the page record before the
   * agent loop starts. When unset (e.g. resolution failed), edits are unrestricted —
   * the agent falls back to its prior behavior rather than blocking all work.
   */
  scope?: PageScope;
  socketEmit?: (room: string, event: string, payload: any) => void;
  executeMcpTool?: (toolName: string, args: any) => Promise<any>;
  /** Optional per-turn token-usage callback. Invoked once per LLM response with
   * that turn's usage. Used by the eval harness to measure real cost through the
   * production path; unset in normal operation (no behavior change). */
  onUsage?: (usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) => void;
  /** Deterministic post-run checks. The coding agent edits; this verifier judges. */
  acceptanceChecks?: AcceptanceCheck[];
  /** Internal cancellation signal for this run. */
  abortSignal?: AbortSignal;
  /** Persisted run id for telemetry/recovery. */
  runId?: string;
}

export interface CodingAgentResult {
  success: boolean;
  message: string;
  iterations: number;
  runId?: string;
  state?: CodingAgentRunState;
  previewUrl?: string;
  branch?: string;
  notAuthorized?: boolean;
  acceptanceStatus?: AcceptanceStatus;
  acceptance?: AcceptanceVerificationResult;
  verification?: AcceptanceVerificationResult;
  recovery?: CodingAgentRecoveryState;
  retryable?: boolean;
  baseCommitSha?: string;
  latestCommitSha?: string;
  editedFiles?: string[];
  /**
   * Summed token usage across this run's self-contained LLM loop, so the caller
   * can charge it to the per-user token/cost cap (ENG-200). The coding agent's
   * turns are invisible to the parent agent-mode meter, so without this its spend
   * never counts. Omitted when the run made no priced LLM call. costUsd is priced
   * via the same source as the shadow meter (llmPricing), in USD.
   */
  usageTotals?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

/** Mutable per-run token accumulator, filled by the loop, read once at result time. */
interface CodingAgentUsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface SearchReplaceEdit {
  search: string;
  replace: string;
}

interface LineNumberEdit {
  start_line: number;
  end_line: number;
  new_content: string;
  expected_content?: string;
}

interface ApplyResult {
  result: string;
  appliedCount: number;
  errors: string[];
}

async function refreshPreviewUrlForDraftBranchStrict(
  result: CodingAgentResult,
  context: CodingAgentContext
): Promise<{ result: CodingAgentResult; blockedReason?: string }> {
  if (!result.success || !result.branch || result.branch === 'main') return { result };

  try {
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/landing-pages/v0/generated/${context.pageId}/preview-url`,
      queryParams: { branch: result.branch },
      context: { userId: context.userId },
    });

    if (data?.previewUrl && data.previewUrl !== result.previewUrl) {
      return { result: { ...result, previewUrl: data.previewUrl } };
    }
    return { result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[CODING AGENT] Could not refresh draft preview URL:', error);
    return { result, blockedReason: `Could not refresh draft preview URL: ${message}` };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err: any = new Error('Coding agent run was cancelled.');
  err.name = 'AbortError';
  throw err;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /cancelled|aborted/i.test(error.message));
}

function isBuildOrDeploymentFailure(result: CodingAgentResult): boolean {
  const text = `${result.message || ''} ${result.acceptance?.summary || ''}`.toLowerCase();
  return /build failed|vercel build failed|deployment failed|buildstatus["']?\s*:\s*["']?error|failed to deploy/.test(text);
}

async function getCurrentCommitSha(context: CodingAgentContext): Promise<string | undefined> {
  try {
    const branch = context.draftBranch || 'main';
    const queryParams: Record<string, string> = branch !== 'main' ? { branch } : {};
    const data = await mcpFetch({
      method: 'GET',
      path: `/api/landing-pages/v0/generated/${context.pageId}/commits`,
      queryParams,
      context: { userId: context.userId },
    });
    const sha = data?.commits?.[0]?.sha;
    return typeof sha === 'string' && sha ? sha : undefined;
  } catch (error) {
    console.warn('[CODING AGENT] Could not capture base commit SHA:', error);
    return undefined;
  }
}

/**
 * Extract a human-readable detail from a failed GitHub API (axios) call so the
 * caller sees the actual validation message (e.g. "Reference does not exist")
 * instead of a bare "Request failed with status code 422". Exported for tests.
 */
export function _describeGithubError(error: any, action: string): string {
  const status = error?.response?.status;
  const data = error?.response?.data;
  const parts: string[] = [];
  if (data && typeof data === 'object') {
    if (data.message) parts.push(String(data.message));
    if (Array.isArray(data.errors)) {
      for (const e of data.errors) {
        const piece = e?.message || e?.code || (typeof e === 'string' ? e : '');
        if (piece) parts.push(String(piece));
      }
    }
    if (parts.length === 0) {
      try { parts.push(JSON.stringify(data)); } catch { /* ignore un-serializable body */ }
    }
  } else if (typeof data === 'string' && data.trim()) {
    parts.push(data.trim());
  }
  if (parts.length === 0 && error?.message) parts.push(String(error.message));
  const detail = parts.join('; ') || 'unknown error';
  return `failed to ${action}${status ? ` (HTTP ${status})` : ''}: ${detail}`;
}

/**
 * GitHub reports a missing git ref as EITHER 404 OR 422 "Reference does not
 * exist", depending on the endpoint: the "Update a reference" endpoint
 * (PATCH .../git/refs/heads/<branch>) returns 422 for an absent ref, not 404.
 * Both mean the branch is absent and should be created. Exported for tests.
 */
export function _isMissingGithubRefError(error: any): boolean {
  const status = error?.response?.status;
  if (status === 404) return true;
  if (status === 422) {
    const data = error?.response?.data;
    const haystack = [
      data?.message,
      ...(Array.isArray(data?.errors) ? data.errors.map((e: any) => e?.message || e?.code) : []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes('does not exist') || haystack.includes('not found');
  }
  return false;
}

/**
 * How many commits the reusable preview branch is ahead of main — i.e. how many
 * unpublished coding_agent edits currently sit on draft/agentweb-preview. Uses
 * GitHub's compare API (base...head). Returns 0 ONLY when the branch is absent
 * (404) or is genuinely identical to / behind main — the cases where resetting
 * the branch to main loses nothing. A positive result means "there is unpublished
 * work here, do not reset."
 *
 * On any OTHER error (5xx / timeout / rate-limit / unparseable body) we fail
 * CLOSED: return a positive count so the caller skips the reset (ENG-176). A
 * transient compare failure must never be read as "0 ahead → safe to force-reset",
 * because that would silently discard genuine unpublished edits — the exact
 * clobber this guard exists to prevent. At worst the new edit builds on a slightly
 * stale branch, which is recoverable; a destroyed edit is not. Exported for tests.
 */
export async function _previewBranchCommitsAheadOfMain(
  repoBase: string,
  headers: Record<string, string>,
): Promise<number> {
  try {
    const res = await axios.get<any>(
      `${repoBase}/compare/main...${encodeURIComponent(LANDING_PAGE_PREVIEW_BRANCH)}`,
      { headers, timeout: GITHUB_API_TIMEOUT_MS },
    );
    const aheadBy = res?.data?.ahead_by;
    return typeof aheadBy === 'number' && aheadBy > 0 ? aheadBy : 0;
  } catch (error) {
    // 404 = preview branch doesn't exist yet → nothing unpublished, reset/create
    // as usual (fail open — creating a fresh branch loses nothing).
    if (_isMissingGithubRefError(error)) {
      return 0;
    }
    // Any other error (5xx / timeout / rate-limit) → fail CLOSED: treat the branch
    // as ahead so the caller skips the reset and layers on top, rather than
    // force-resetting to main and destroying unpublished work on a transient hiccup.
    console.warn(
      '[CODING AGENT] Could not compare preview branch to main; assuming unpublished ' +
        'commits exist and skipping reset to avoid clobbering them (ENG-176):',
      error instanceof Error ? error.message : error,
    );
    return 1;
  }
}

async function resetReusablePreviewBranchToMain(context: CodingAgentContext): Promise<void> {
  if (context.draftBranch !== LANDING_PAGE_PREVIEW_BRANCH) return;

  const page = await getLandingPageById(context.pageId);
  if (!page?.githubRepoUrl) {
    throw new Error('Cannot prepare preview branch: landing page has no GitHub repository');
  }

  const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) {
    throw new Error('Cannot prepare preview branch: invalid GitHub repo URL');
  }

  const [, owner, rawRepo] = repoMatch;
  const repoName = rawRepo.replace('.git', '');
  const repoBase = `https://api.github.com/repos/${owner}/${repoName}`;
  const { token } = await getGitHubOrgToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };

  let mainSha: string | undefined;
  try {
    const mainRef = await axios.get<any>(`${repoBase}/git/ref/heads/main`, {
      headers,
      timeout: GITHUB_API_TIMEOUT_MS,
    });
    mainSha = mainRef.data?.object?.sha;
  } catch (error) {
    throw new Error(`Cannot prepare preview branch: ${_describeGithubError(error, 'read the repo main branch')}`);
  }
  if (!mainSha) {
    throw new Error('Cannot prepare preview branch: main SHA not found');
  }

  // ENG-176: If the reusable preview branch already carries commits that are not
  // yet on main, those are UNPUBLISHED edits from an earlier coding_agent run on
  // this page. Force-resetting the branch to main here would silently discard
  // them, so a later sequential edit on the same page clobbers the earlier one
  // (e.g. the first-added book card disappears after publish). In that case we
  // must layer the new edit on top of the existing preview branch instead of
  // resetting. We only reset when the branch is absent or fully published
  // (not ahead of main) — the case the reusable branch was designed for.
  const aheadBy = await _previewBranchCommitsAheadOfMain(repoBase, headers);
  if (aheadBy > 0) {
    console.log(
      `[CODING AGENT] ${LANDING_PAGE_PREVIEW_BRANCH} has ${aheadBy} unpublished commit(s) ahead of main; ` +
        `layering new edit on top instead of resetting (ENG-176)`,
    );
    return;
  }

  try {
    await axios.patch(
      `${repoBase}/git/refs/heads/${LANDING_PAGE_PREVIEW_BRANCH}`,
      { sha: mainSha, force: true },
      { headers, timeout: GITHUB_API_TIMEOUT_MS },
    );
    console.log(`[CODING AGENT] Reset ${LANDING_PAGE_PREVIEW_BRANCH} to main (${mainSha.substring(0, 7)})`);
    return;
  } catch (error: any) {
    // The preview branch doesn't exist yet — create it below. GitHub's "Update
    // a reference" API reports a missing ref as EITHER 404 OR 422 "Reference
    // does not exist", so both mean "branch absent" and must fall through to
    // creation. Previously only 404 fell through, so the common 422 case
    // rethrew a bare "Request failed with status code 422" and blocked EVERY
    // coding_agent edit on otherwise-healthy pages whose draft branch had never
    // been created (ENG-159).
    if (!_isMissingGithubRefError(error)) {
      throw new Error(`Cannot prepare preview branch: ${_describeGithubError(error, 'reset the preview branch')}`);
    }
  }

  try {
    await axios.post(
      `${repoBase}/git/refs`,
      { ref: `refs/heads/${LANDING_PAGE_PREVIEW_BRANCH}`, sha: mainSha },
      { headers, timeout: GITHUB_API_TIMEOUT_MS },
    );
    console.log(`[CODING AGENT] Created ${LANDING_PAGE_PREVIEW_BRANCH} from main (${mainSha.substring(0, 7)})`);
  } catch (error) {
    throw new Error(`Cannot prepare preview branch: ${_describeGithubError(error, 'create the preview branch')}`);
  }
}

async function rollbackEditedFiles(input: {
  context: CodingAgentContext;
  baseCommitSha?: string;
  editedFiles?: string[];
}): Promise<CodingAgentRecoveryState> {
  const files = Array.from(new Set(input.editedFiles || [])).filter(Boolean);
  if (!input.baseCommitSha || files.length === 0) {
    return {
      attempted: false,
      status: 'not_needed',
      reason: !input.baseCommitSha ? 'No base commit SHA was captured.' : 'No edited files were tracked.',
      baseCommitSha: input.baseCommitSha,
    };
  }

  const failures: string[] = [];
  for (const filePath of files) {
    try {
      await executeTool('revert_file', {
        file_path: filePath,
        commit_sha: input.baseCommitSha,
        commit_message: `Rollback ${filePath} after failed coding-agent run`,
      }, input.context);
    } catch (error) {
      failures.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    return {
      attempted: true,
      status: 'failed',
      reason: failures.join('; '),
      baseCommitSha: input.baseCommitSha,
    };
  }

  return {
    attempted: true,
    status: 'succeeded',
    reason: 'Rolled back edited files to the captured base commit after a broken build/deploy.',
    baseCommitSha: input.baseCommitSha,
  };
}

/**
 * Structured result for tools that produce an image (e.g. take_screenshot).
 * The agent loop renders this as an Anthropic image content block so the model
 * can visually analyze the screenshot, rather than receiving an opaque string.
 */
interface ToolImageResult {
  kind: 'image';
  mediaType: string;
  data: string; // base64-encoded image
}

function isToolImageResult(r: unknown): r is ToolImageResult {
  return typeof r === 'object' && r !== null && (r as any).kind === 'image';
}

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_CODING_AGENT_MODEL = 'anthropic.claude-sonnet-4-6'; // Fallback if settings fetch fails
// Hard backstop for the entire agent run. Must comfortably fit several LLM turns:
// each turn can legitimately take a few minutes on a slow model (e.g. Opus), and a
// real edit needs ~8-12 turns (read → search → edit → check_deployment → fix). A
// tight budget here is what silently killed broad edits before they could finish.
const AGENT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes max for the entire agent run
const MAX_TOOL_RESULT_CHARS = 30000; // Truncate tool results to prevent context bloat
const MAX_RETRIES = 2;

// Shared message for an authorization denial. Used by the upfront preflight and
// the mid-run 403 catch so the user sees one consistent, actionable instruction.
const NOT_AUTHORIZED_MESSAGE =
  'Not authorized to edit this landing page. The org owner needs to add you as an editor under Settings → Organization → Org-wide Sharing → Landing Pages.';

function is403Error(e: unknown): boolean {
  return e instanceof Error && /API error \(403\)/i.test(e.message);
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const CODING_AGENT_SYSTEM_PROMPT = `You are a coding agent that edits landing page code in a GitHub repository connected to Vercel. Your edits go to the reusable draft branch draft/agentweb-preview, creating a Vercel preview deployment for user review.

## Project Architecture
This is a **Next.js 15 (App Router)** project — NOT a static HTML site.
- Main page component: \`app/page.tsx\` (root page) or \`app/<slug>/page.tsx\` (sub-pages)
- Styling: Tailwind CSS classes only — do NOT add \`<style jsx>\`, raw \`<style>\` blocks, or inline styles
- There is NO \`index.html\`. Do not edit or create static HTML files for page content.
- Shared UI components live in \`components/\`
- Global CSS: \`app/globals.css\`
- API routes: \`app/api/\`
- Config: \`next.config.js\`, \`tailwind.config.js\`
- The initial user message includes a file listing. Use it to orient yourself before editing.

## Creating New Files
You CAN create new files using \`edit_file\`. For a file that does not yet exist:
- Use \`line_edits\` with a single block: \`{ start_line: 1, end_line: 1, new_content: "<full file content>" }\`
- Or use \`edits\` with a search/replace where \`search\` is an empty string \`""\` and \`replace\` is the full file content.
The tool will create the file if it doesn't exist. No need to read it first.

## Editing multiple files for one fix
If a single logical change requires editing 2+ files (e.g. a page plus a new API route it calls), use \`edit_files\` instead of multiple \`edit_file\` calls — it lands all of them in ONE atomic commit, so the repo never sits in a broken intermediate state between commits.

## Principles
- Make targeted, small edits (1-5 edit blocks per call). Never rewrite entire files.
- For files over 5KB, use search_in_file to locate code before reading. Use read_file with line ranges, not whole files.
- Prefer line_edits (from line numbers in search/read output) over search/replace.
- Do NOT check_deployment after every edit. Make ALL your edits first, then check_deployment ONCE at the end. If the build fails, fix it. If still failing after 2 attempts, revert_file.
- Only browse_page to verify when visual correctness matters for the task.
- Do not make changes the user did not ask for.
- Before your first edit, note the current commit SHA (via list_commits) so you can revert if needed.
- When done, check_deployment once, then call report_to_user with a summary and the preview URL. The platform may run deterministic acceptance checks after you finish; do not claim success unless the build/deployment information you saw supports it.

## Adding images and logos
- Always use a direct URL in <img src="..."> — never try to upload or embed binary files.
- For public company logos: use Google's favicon service: <img src="https://www.google.com/s2/favicons?domain={domain}&sz=128" /> (e.g., domain=google.com). Works for any company domain.
- For the user's own brand logo: the task_description will include the logo URL (from brand guidelines or an S3 link). Use that URL directly in the img tag.

Skip steps that aren't needed. For a simple text change, you might just: read the file, edit it, check deployment, and report. Use your judgment.`;

// ─── Page Scope ───────────────────────────────────────────────────────────────
// Many landing pages live in ONE shared GitHub repo: a root page owns the
// top-level app/ files (app/page.tsx, app/layout.tsx, components/, …) and every
// other page is an app/<slug>/ route. A run is keyed on one pageId, but that
// pageId may be just one route of a larger multi-route project — and the coding
// agent's file API is ALREADY physically confined to that one repo. So the
// editable boundary is the WHOLE repo: a run may freely edit any route directory
// or shared file in its own project. The only writes rejected are unsafe paths
// that escape the repo. (We keep soft "make only the change asked for" guidance
// in the prompt to discourage over-reach without hard-blocking sibling routes.)

/** Strip a leading "./" or "/" and collapse backslashes so comparisons are stable. */
function normalizeRepoPath(filePath: string): string {
  return (filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * Build the editable boundary for `page` given all of the owner's pages. The
 * boundary is the page's repo; route slugs are collected from the OTHER pages
 * that share the same githubRepoUrl (purely informational for the prompt).
 */
export function resolvePageScope(
  page: Pick<GeneratedLandingPage, 'id' | 'slug' | 'githubRepoUrl'>,
  repoPages: Pick<GeneratedLandingPage, 'id' | 'slug' | 'githubRepoUrl'>[]
): PageScope {
  const repoUrl = (page.githubRepoUrl || '').trim();
  const routeSlugs = Array.from(
    new Set(
      repoPages
        // Only pages in the SAME repo are routes of this project. The owner may
        // have other landing pages in entirely separate repos — those are not
        // reachable here and must not be counted.
        .filter((p) => (p.githubRepoUrl || '').trim() === repoUrl && !!p.slug)
        .map((p) => (p.slug as string).trim())
        .filter((s) => s !== '')
    )
  );
  return { repoUrl, routeSlugs };
}

/**
 * True if `filePath` is a safe, repo-relative path the agent may write. Repo-wide
 * scope means any in-repo file is editable; we only reject paths that escape the
 * repo (empty, absolute, or parent-traversal). Scope-agnostic by design.
 */
export function isSafeRepoPath(filePath: string): boolean {
  const path = normalizeRepoPath(filePath);
  if (!path) return false;
  // Reject any parent-traversal segment — it could climb out of the repo root.
  if (path === '..' || path.startsWith('../') || path.includes('/../') || path.endsWith('/..')) {
    return false;
  }
  return true;
}

/** The scope guidance appended to the system prompt for a scoped run. */
export function buildScopeSystemClause(scope: PageScope): string {
  const routes = scope.routeSlugs.length
    ? scope.routeSlugs.map((s) => `\`app/${s}/\``).join(', ')
    : '(this project has a single route)';
  return `

## Edit scope
You are editing ONE GitHub repository (one Vercel project). This project may contain MULTIPLE page routes that all live in the same repo — its route directories are: ${routes}. You MAY edit any file in this repo, including any of those route directories and shared files (\`components/\`, \`app/layout.tsx\`, \`app/globals.css\`, etc.) when the task calls for it.
Make ONLY the specific change the user asked for. Do not relabel copy, rename sections, or touch routes, components, or files unrelated to the request — even though you are permitted to.`;
}

/** Corrective message returned to the agent when it tries to write an unsafe path. */
function scopeViolationMessage(filePath: string): string {
  return `Refusing to edit "${filePath}": that path is outside the repository (it uses an absolute path or "../" traversal). Use a repo-relative path such as "app/<route>/page.tsx" or "components/...".`;
}

// ─── Search/Replace Engine ──────────────────────────────────────────────────

export function applySearchReplace(content: string, edits: SearchReplaceEdit[]): ApplyResult {
  let result = content;
  let appliedCount = 0;
  const errors: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];

    if (edit.search === undefined || edit.search === null) {
      errors.push(`Edit ${i + 1}: search string is missing`);
      continue;
    }

    // Empty search on an empty file = create the file with replace content
    if (edit.search === '' && result === '') {
      result = edit.replace;
      appliedCount++;
      continue;
    }

    if (edit.search === '') {
      errors.push(`Edit ${i + 1}: search string is empty (only valid when creating a new empty file)`);
      continue;
    }

    // Try exact match first
    const firstIdx = result.indexOf(edit.search);
    if (firstIdx === -1) {
      // Try whitespace-normalized match (trim trailing spaces per line)
      const normalizeLines = (s: string) => s.split('\n').map(line => line.trimEnd()).join('\n');
      const normalizedContent = normalizeLines(result);
      const normalizedSearch = normalizeLines(edit.search);

      const normIdx = normalizedContent.indexOf(normalizedSearch);
      if (normIdx === -1) {
        // Show context to help the LLM correct the search string
        const preview = result.substring(0, 200);
        errors.push(
          `Edit ${i + 1}: search string not found in file. ` +
          `Search (first 100 chars): "${edit.search.substring(0, 100)}". ` +
          `File starts with: "${preview.substring(0, 100)}"`
        );
        continue;
      }

      // Find the actual range in the original content by mapping from normalized positions
      // Since normalization only trims trailing spaces, line count is preserved
      const normalizedLines = normalizedContent.split('\n');
      const searchLines = normalizedSearch.split('\n');

      // Find which line the match starts on
      let charCount = 0;
      let startLine = -1;
      for (let l = 0; l < normalizedLines.length; l++) {
        if (charCount === normIdx || charCount <= normIdx && normIdx < charCount + normalizedLines[l].length + 1) {
          startLine = l;
          break;
        }
        charCount += normalizedLines[l].length + 1; // +1 for \n
      }

      if (startLine === -1) {
        errors.push(`Edit ${i + 1}: whitespace-normalized match found but could not map back to original`);
        continue;
      }

      // Replace by original lines
      const originalLines = result.split('\n');
      const endLine = startLine + searchLines.length;
      const replacementLines = edit.replace.split('\n');
      originalLines.splice(startLine, searchLines.length, ...replacementLines);
      result = originalLines.join('\n');
      appliedCount++;
      continue;
    }

    // Check for ambiguous match (found more than once)
    const secondIdx = result.indexOf(edit.search, firstIdx + 1);
    if (secondIdx !== -1) {
      errors.push(
        `Edit ${i + 1}: search string found multiple times (at positions ${firstIdx} and ${secondIdx}). ` +
        `Make the search string more specific to match exactly one location.`
      );
      continue;
    }

    // Apply the replacement
    result = result.substring(0, firstIdx) + edit.replace + result.substring(firstIdx + edit.search.length);
    appliedCount++;
  }

  return { result, appliedCount, errors };
}

// ─── Line-Number Edit Engine ─────────────────────────────────────────────────

export function applyLineNumberEdit(content: string, edits: LineNumberEdit[]): ApplyResult {
  const lines = content.split('\n');
  let appliedCount = 0;
  const errors: string[] = [];

  // Sort edits by start_line descending so later edits don't shift earlier line numbers
  const sortedEdits = [...edits].sort((a, b) => b.start_line - a.start_line);

  for (let i = 0; i < sortedEdits.length; i++) {
    const edit = sortedEdits[i];

    if (edit.start_line < 1 || edit.end_line > lines.length) {
      errors.push(`Edit ${i + 1}: line range ${edit.start_line}-${edit.end_line} is out of range (file has ${lines.length} lines).`);
      continue;
    }

    if (edit.start_line > edit.end_line) {
      errors.push(`Edit ${i + 1}: start_line (${edit.start_line}) > end_line (${edit.end_line}).`);
      continue;
    }

    // Validate expected_content if provided (rough match — trim + compare)
    if (edit.expected_content !== undefined) {
      const actualLines = lines.slice(edit.start_line - 1, edit.end_line);
      const actual = actualLines.join('\n').trim();
      const expected = edit.expected_content.trim();
      if (actual !== expected) {
        errors.push(
          `Edit ${i + 1}: expected content at lines ${edit.start_line}-${edit.end_line} does not match. ` +
          `Expected: "${expected.substring(0, 80)}..." Got: "${actual.substring(0, 80)}..."`
        );
        continue;
      }
    }

    // Apply the replacement
    const newLines = edit.new_content === '' ? [] : edit.new_content.split('\n');
    lines.splice(edit.start_line - 1, edit.end_line - edit.start_line + 1, ...newLines);
    appliedCount++;
  }

  return { result: lines.join('\n'), appliedCount, errors };
}

// ─── Tool Definitions (Anthropic native format) ─────────────────────────────

function getToolDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: 'list_files',
      description: 'List all files in the landing page repository. Returns file paths and sizes.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    },
    {
      name: 'search_in_file',
      description: 'Search for a pattern in a file. Returns matching lines with line numbers and 3 lines of surrounding context. Use this BEFORE read_file on large files to find the exact lines you need to edit.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file to search in'
          },
          pattern: {
            type: 'string',
            description: 'Search pattern (case-insensitive substring match)'
          }
        },
        required: ['file_path', 'pattern']
      }
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file from the repository. Returns content with line numbers prepended. For large files, use start_line and end_line to read only a specific section.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file (e.g., "app/page.tsx", "app/globals.css")'
          },
          start_line: {
            type: 'number',
            description: 'First line to read (1-indexed). If omitted, reads from the beginning.'
          },
          end_line: {
            type: 'number',
            description: 'Last line to read (1-indexed, inclusive). If omitted, reads to the end.'
          }
        },
        required: ['file_path']
      }
    },
    {
      name: 'edit_file',
      description: 'Edit a file. Supports two modes:\n1. Line-number edits (preferred): provide "line_edits" array with {start_line, end_line, new_content}. Line numbers come from read_file or search_in_file.\n2. Search/replace edits (fallback): provide "edits" array with {search, replace}. The search string must match exactly once.\nUse line_edits when you have line numbers. Use edits as a fallback for small, unambiguous changes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file to edit'
          },
          line_edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                start_line: {
                  type: 'number',
                  description: 'First line to replace (1-indexed, from read_file or search_in_file output)'
                },
                end_line: {
                  type: 'number',
                  description: 'Last line to replace (1-indexed, inclusive)'
                },
                new_content: {
                  type: 'string',
                  description: 'Replacement content (can be empty string to delete lines)'
                },
                expected_content: {
                  type: 'string',
                  description: 'Optional: expected content at those lines (safety check). Edit is rejected if it does not match.'
                }
              },
              required: ['start_line', 'end_line', 'new_content']
            },
            description: 'Array of line-number-based edits. Preferred over search/replace edits.'
          },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search: {
                  type: 'string',
                  description: 'Exact string to find in the file (must match exactly once)'
                },
                replace: {
                  type: 'string',
                  description: 'Replacement string'
                }
              },
              required: ['search', 'replace']
            },
            description: 'Array of search/replace edits (fallback mode). Use line_edits instead when possible.'
          },
          commit_message: {
            type: 'string',
            description: 'Git commit message describing the changes'
          }
        },
        required: ['file_path']
      }
    },
    {
      name: 'edit_files',
      description: 'Commit changes to MULTIPLE files in ONE atomic commit. Use this instead of calling edit_file N times when a single logical fix spans 2+ files (e.g. editing a page AND adding a new API route it depends on) — landing them in separate commits can leave the repo in a broken intermediate state if something fails partway. Each file entry supports the same line_edits/edits modes as edit_file, or deleted: true to remove a file.',
      input_schema: {
        type: 'object' as const,
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file_path: {
                  type: 'string',
                  description: 'Path to the file'
                },
                line_edits: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      start_line: { type: 'number', description: 'First line to replace (1-indexed)' },
                      end_line: { type: 'number', description: 'Last line to replace (1-indexed, inclusive)' },
                      new_content: { type: 'string', description: 'Replacement content (can be empty string to delete lines)' },
                      expected_content: { type: 'string', description: 'Optional: expected content at those lines (safety check)' }
                    },
                    required: ['start_line', 'end_line', 'new_content']
                  },
                  description: 'Line-number-based edits for this file (preferred). Omit if using edits or deleted.'
                },
                edits: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      search: { type: 'string', description: 'Exact string to find (must match exactly once)' },
                      replace: { type: 'string', description: 'Replacement string' }
                    },
                    required: ['search', 'replace']
                  },
                  description: 'Search/replace edits for this file (fallback). Omit if using line_edits or deleted.'
                },
                deleted: {
                  type: 'boolean',
                  description: 'Set true to remove this file in the same commit instead of editing it.'
                }
              },
              required: ['file_path']
            },
            description: 'Files to commit together atomically. Each needs line_edits, edits, or deleted: true.'
          },
          commit_message: {
            type: 'string',
            description: 'Git commit message describing the combined change'
          }
        },
        required: ['files']
      }
    },
    {
      name: 'check_deployment',
      description: 'Check the Vercel deployment status. Use this after editing files to verify the build succeeded.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    },
    {
      name: 'report_to_user',
      description: 'Return a final report to the user. This ends the coding session. Include a summary of all changes made, files modified, and deployment status. IMPORTANT: Always include the preview_url if you obtained one from check_deployment.',
      input_schema: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string',
            description: 'Summary message to show the user'
          },
          status: {
            type: 'string',
            enum: ['success', 'error', 'partial'],
            description: 'Overall status of the coding task'
          },
          preview_url: {
            type: 'string',
            description: 'The Vercel preview deployment URL for the user to review changes before publishing'
          }
        },
        required: ['message', 'status']
      }
    },
    {
      name: 'list_commits',
      description: 'List recent commits in the repository. Optionally filter by file path. Use this before making changes to record the current commit SHA, so you can revert if something goes wrong.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Optional file path to filter commits (e.g., "app/page.tsx"). If omitted, lists all recent commits.'
          }
        },
        required: []
      }
    },
    {
      name: 'revert_file',
      description: 'Revert a file to its state at a previous commit. Use this to undo changes that broke the build or damaged the page. Provide the commit SHA from list_commits.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file to revert (e.g., "app/page.tsx")'
          },
          commit_sha: {
            type: 'string',
            description: 'The commit SHA to revert to (from list_commits output)'
          },
          commit_message: {
            type: 'string',
            description: 'Git commit message for the revert (e.g., "Revert app/page.tsx to pre-edit state")'
          }
        },
        required: ['file_path', 'commit_sha']
      }
    },
    {
      name: 'browse_page',
      description: 'Navigate to a URL and get a text snapshot of the page content (accessibility tree). Use this to verify your edits are visible on the deployed site. Returns a structured description of all visible elements on the page.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to (e.g., the Vercel deployment URL)'
          }
        },
        required: ['url']
      }
    },
    {
      name: 'take_screenshot',
      description: 'Take a screenshot of the current browser page. Use after browse_page to capture a visual snapshot. The image is returned to you directly — actually look at it to verify visual correctness (layout, spacing, colors), do not assume the page is correct.',
      input_schema: {
        type: 'object' as const,
        properties: {
          full_page: {
            type: 'boolean',
            description: 'Whether to capture the full scrollable page (true) or just the visible viewport (false). Defaults to false.'
          }
        },
        required: []
      }
    },
  ];
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

/**
 * Shared by `edit_file` and `edit_files` (ENG-497): read a file's current
 * content (from the draft branch if applicable; a 404 means "doesn't exist
 * yet, start empty" so new files can be created), then apply either
 * line_edits (preferred) or edits (search/replace fallback) to compute the
 * new full content. Does NOT write anything — callers batch the write
 * themselves (one PUT per file for edit_file, one atomic multi-file PUT for
 * edit_files).
 */
async function computeFileEdit(
  basePath: string,
  branchQuery: Record<string, string>,
  context: CodingAgentContext,
  file: { file_path: string; line_edits?: unknown; edits?: unknown }
): Promise<
  | { ok: true; content: string; appliedCount: number; totalEdits: number; errors: string[] }
  | { ok: false; reason: 'no_edits' }
  | { ok: false; reason: 'zero_applied'; errors: string[] }
> {
  const hasLineEdits = Array.isArray(file.line_edits) && file.line_edits.length > 0;
  const hasSearchReplace = Array.isArray(file.edits) && file.edits.length > 0;

  if (!hasLineEdits && !hasSearchReplace) {
    return { ok: false, reason: 'no_edits' };
  }

  let currentContent = '';
  try {
    const fileData = await mcpFetch({
      method: 'GET',
      path: `${basePath}/file-content`,
      queryParams: { path: file.file_path, ...branchQuery },
      context: { userId: context.userId }
    });
    currentContent = fileData.content || '';
  } catch (readErr: unknown) {
    if (readErr instanceof Error && /API error \(404\)/i.test(readErr.message)) {
      currentContent = '';
    } else {
      throw readErr;
    }
  }

  let newContent: string;
  let appliedCount: number;
  let errors: string[];
  let totalEdits: number;

  if (hasLineEdits) {
    const editResult = applyLineNumberEdit(currentContent, file.line_edits as any);
    newContent = editResult.result;
    appliedCount = editResult.appliedCount;
    errors = editResult.errors;
    totalEdits = (file.line_edits as any[]).length;
  } else {
    const editResult = applySearchReplace(currentContent, file.edits as any);
    newContent = editResult.result;
    appliedCount = editResult.appliedCount;
    errors = editResult.errors;
    totalEdits = (file.edits as any[]).length;
  }

  if (appliedCount === 0) {
    return { ok: false, reason: 'zero_applied', errors };
  }
  return { ok: true, content: newContent, appliedCount, totalEdits, errors };
}

async function executeTool(
  toolName: string,
  args: any,
  context: CodingAgentContext
): Promise<string | ToolImageResult> {
  throwIfAborted(context.abortSignal);
  const basePath = `/api/landing-pages/v0/generated/${context.pageId}`;
  const branch = context.draftBranch || "main";
  const branchQuery: Record<string, string> = branch !== "main" ? { branch } : {};

  // Safety guard: block writes whose path escapes the repo (absolute or "../"
  // traversal). Edits across route directories within the SAME repo are allowed —
  // many routes share one repo and are one project. Reads stay unrestricted.
  if (
    (toolName === 'edit_file' || toolName === 'revert_file') &&
    args.file_path &&
    !isSafeRepoPath(args.file_path)
  ) {
    return scopeViolationMessage(args.file_path);
  }
  // edit_files (ENG-497): same guard, applied to EVERY file in the batch — one
  // bad path blocks the whole atomic commit, matching update-files' own
  // whole-batch rejection.
  if (toolName === 'edit_files' && Array.isArray(args.files)) {
    for (const f of args.files) {
      if (f?.file_path && !isSafeRepoPath(f.file_path)) {
        return scopeViolationMessage(f.file_path);
      }
    }
  }

  switch (toolName) {
    case 'list_files': {
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/files`,
        queryParams: branchQuery,
        context: { userId: context.userId }
      });
      const files = data.files || [];
      return files.map((f: any) => `${f.path} (${f.size} bytes)`).join('\n') || 'No files found.';
    }

    case 'search_in_file': {
      if (!args.file_path || !args.pattern) {
        return 'Error: file_path and pattern are required.';
      }
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/file-content`,
        queryParams: { path: args.file_path, ...branchQuery },
        context: { userId: context.userId }
      });
      const content = data.content || '';
      const lines = content.split('\n');
      const pattern = args.pattern.toLowerCase();
      const contextLines = 3;
      const maxOutputChars = 5000;

      // Find matching line indices
      const matchIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(pattern)) {
          matchIndices.push(i);
        }
      }

      if (matchIndices.length === 0) {
        return `No matches found for "${args.pattern}" in ${args.file_path}.`;
      }

      // Build output with context, merging overlapping ranges
      let output = `Found ${matchIndices.length} match(es) for "${args.pattern}" in ${args.file_path} (${lines.length} lines total):\n\n`;
      const shown = new Set<number>();

      for (const idx of matchIndices) {
        const start = Math.max(0, idx - contextLines);
        const end = Math.min(lines.length - 1, idx + contextLines);
        for (let i = start; i <= end; i++) {
          if (!shown.has(i)) {
            const marker = i === idx ? '>>>' : '   ';
            output += `${marker} ${i + 1}: ${lines[i]}\n`;
            shown.add(i);
          }
        }
        output += '---\n';
        if (output.length > maxOutputChars) {
          output += `\n... [truncated, ${matchIndices.length - matchIndices.indexOf(idx) - 1} more matches]`;
          break;
        }
      }

      return output;
    }

    case 'read_file': {
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/file-content`,
        queryParams: { path: args.file_path, ...branchQuery },
        context: { userId: context.userId }
      });
      const content = data.content || '';
      const lines = content.split('\n');

      // Apply line range if specified
      const startLine = args.start_line ? Math.max(1, args.start_line) : 1;
      const endLine = args.end_line ? Math.min(lines.length, args.end_line) : lines.length;

      // Prepend line numbers
      const numberedLines = lines
        .slice(startLine - 1, endLine)
        .map((line: string, i: number) => `${startLine + i}: ${line}`);

      let result = numberedLines.join('\n');
      if (args.start_line || args.end_line) {
        result = `[Lines ${startLine}-${endLine} of ${lines.length}]\n${result}`;
      } else {
        result = `[${lines.length} lines total]\n${result}`;
      }
      return result;
    }

    case 'edit_file': {
      const computed = await computeFileEdit(basePath, branchQuery, context, {
        file_path: args.file_path,
        line_edits: args.line_edits,
        edits: args.edits,
      });
      if (!computed.ok) {
        if (computed.reason === 'no_edits') {
          return 'Error: either line_edits or edits array is required and must not be empty.';
        }
        return `Failed to apply edits. Errors:\n${computed.errors.join('\n')}`;
      }
      const { content: newContent, appliedCount, totalEdits, errors } = computed;

      // Write back via GitHub API
      const writeResult = await mcpFetch({
        method: 'PUT',
        path: `${basePath}/github-edit`,
        body: {
          file_path: args.file_path,
          content: newContent,
          commit_message: args.commit_message || `Edit ${args.file_path}`,
          ...(branch !== "main" ? { branch } : {}),
        },
        context: { userId: context.userId }
      });

      let response = `Applied ${appliedCount}/${totalEdits} edits to ${args.file_path}.`;
      if (writeResult.is_staging) {
        response += ` Changes pushed to draft branch ${branch}. A preview deployment is being created.`;
      } else if (writeResult.deployed_url) {
        response += ` Changes will auto-deploy to ${writeResult.deployed_url}.`;
      }
      if (writeResult.commit_url) {
        response += ` Commit: ${writeResult.commit_url}`;
      }
      if (errors.length > 0) {
        response += `\nWarnings (${errors.length} edits skipped):\n${errors.join('\n')}`;
      }
      return response;
    }

    case 'edit_files': {
      // ENG-497: commit several files in ONE atomic commit — use this instead
      // of calling edit_file N times when a single logical fix spans multiple
      // files (the ENG-443 incident's exact shape: a lander file + a new API
      // route landing together).
      if (!Array.isArray(args.files) || args.files.length === 0) {
        return 'Error: files must be a non-empty array.';
      }

      const filesToCommit: Array<{ file_path: string; content?: string; deleted?: boolean }> = [];

      for (const f of args.files) {
        if (!f?.file_path || typeof f.file_path !== 'string') {
          return 'Error: each file requires a file_path.';
        }
        if (f.deleted) {
          filesToCommit.push({ file_path: f.file_path, deleted: true });
          continue;
        }
        const computed = await computeFileEdit(basePath, branchQuery, context, f);
        if (!computed.ok) {
          if (computed.reason === 'no_edits') {
            return `Error: ${f.file_path}: either line_edits or edits array is required and must not be empty (or deleted: true).`;
          }
          return `Error: ${f.file_path}: failed to apply edits. Errors:\n${computed.errors.join('\n')}`;
        }
        // A file that only PARTLY applied (some edit blocks matched, some didn't)
        // is refused rather than committed with a footnote warning: edit_files'
        // whole point is one atomic, trustworthy commit, and bundling a silently
        // incomplete file alongside genuinely good ones — reported as one clean
        // success — is worse here than for single-file edit_file (Greptile).
        // No partial commit made; nothing in this batch has been written yet.
        if (computed.errors.length > 0) {
          return `Error: ${f.file_path}: only ${computed.appliedCount}/${computed.totalEdits} edits applied — refusing to commit a partially-edited file as part of an atomic multi-file batch. Errors:\n${computed.errors.join('\n')}\nFix or drop this file's edits and retry the whole batch.`;
        }
        filesToCommit.push({ file_path: f.file_path, content: computed.content });
      }

      const writeResult = await mcpFetch({
        method: 'PUT',
        path: `${basePath}/update-files`,
        body: {
          files: filesToCommit,
          commit_message: args.commit_message || `Update ${filesToCommit.length} files`,
          ...(branch !== "main" ? { branch } : {}),
        },
        context: { userId: context.userId }
      });

      let response = `Committed ${filesToCommit.length} file(s) in one atomic commit: ${filesToCommit.map((f) => f.file_path).join(', ')}.`;
      if (writeResult.is_staging) {
        response += ` Changes pushed to draft branch ${branch}. A preview deployment is being created.`;
      } else if (writeResult.deployed_url) {
        response += ` Changes will auto-deploy to ${writeResult.deployed_url}.`;
      }
      if (writeResult.commit_url) {
        response += ` Commit: ${writeResult.commit_url}`;
      }
      return response;
    }

    case 'list_commits': {
      const queryParams: Record<string, string> = { ...branchQuery };
      if (args.file_path) queryParams.path = args.file_path;
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/commits`,
        queryParams,
        context: { userId: context.userId }
      });
      const commits = data.commits || [];
      if (commits.length === 0) return 'No commits found.';
      return commits.map((c: any) =>
        `${c.sha.substring(0, 7)} | ${c.date} | ${c.message.split('\n')[0]}`
      ).join('\n');
    }

    case 'revert_file': {
      if (!args.file_path || !args.commit_sha) {
        return 'Error: file_path and commit_sha are required.';
      }

      // Step 1: Read file content at the target commit
      const oldFileData = await mcpFetch({
        method: 'GET',
        path: `${basePath}/file-at-commit`,
        queryParams: { path: args.file_path, ref: args.commit_sha },
        context: { userId: context.userId }
      });

      if (!oldFileData.content) {
        return `Error: Could not read ${args.file_path} at commit ${args.commit_sha}. The file may not exist at that commit.`;
      }

      // Step 2: Write it back via the existing github-edit endpoint
      const writeResult = await mcpFetch({
        method: 'PUT',
        path: `${basePath}/github-edit`,
        body: {
          file_path: args.file_path,
          content: oldFileData.content,
          commit_message: args.commit_message || `Revert ${args.file_path} to commit ${args.commit_sha.substring(0, 7)}`,
          ...(branch !== "main" ? { branch } : {}),
        },
        context: { userId: context.userId }
      });

      let response = `Reverted ${args.file_path} to commit ${args.commit_sha.substring(0, 7)}.`;
      if (writeResult.deployed_url) {
        response += ` Changes will auto-deploy to ${writeResult.deployed_url}.`;
      }
      if (writeResult.commit_url) {
        response += ` Commit: ${writeResult.commit_url}`;
      }
      return response;
    }

    case 'check_deployment': {
      if (branch !== "main") {
        // For draft branches, poll for preview deployment URL.
        // Vercel builds triggered by PR creation take 30-120 seconds to complete,
        // so we retry until the build finishes rather than returning "building" to the LLM.
        const MAX_POLL_ATTEMPTS = 8;
        const POLL_INTERVAL_MS = 15000;
        let lastData: any = {};
        for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
          lastData = await mcpFetch({
            method: 'GET',
            path: `${basePath}/preview-url`,
            queryParams: { branch },
            context: { userId: context.userId }
          });
          // Return immediately on terminal states
          if (
            lastData.buildStatus === 'success' ||
            lastData.buildStatus === 'error' ||
            lastData.buildStatus === 'canceled' ||
            lastData.buildStatus === 'not_found'
          ) {
            return JSON.stringify(lastData, null, 2);
          }
          // Still building — wait and retry (unless this is the last attempt)
          if (attempt < MAX_POLL_ATTEMPTS) {
            console.log(`[CODING AGENT] check_deployment: branch="${branch}" status="${lastData.buildStatus}" (attempt ${attempt}/${MAX_POLL_ATTEMPTS}), retrying in ${POLL_INTERVAL_MS / 1000}s...`);
            throwIfAborted(context.abortSignal);
            await _sleepFn(POLL_INTERVAL_MS);
            throwIfAborted(context.abortSignal);
          }
        }
        // Timed out — return with a note so the LLM can inform the user
        return JSON.stringify({
          ...lastData,
          buildStatus: 'building',
          note: 'Vercel build is still in progress. The preview URL will be available in 1-2 minutes.'
        }, null, 2);
      }
      const data = await mcpFetch({
        method: 'GET',
        path: `${basePath}/deployment-status`,
        context: { userId: context.userId }
      });
      return JSON.stringify(data, null, 2);
    }

    case 'report_to_user': {
      // This is handled in the main loop — just return the message
      return args.message || 'Done.';
    }

    case 'browse_page': {
      if (!context.executeMcpTool) {
        return 'Error: Browser tools are not available in this context.';
      }
      // Navigate to the URL
      await context.executeMcpTool('playwright_browser_navigate', { url: args.url });
      // Get accessibility snapshot (text representation of page)
      const snapshot = await context.executeMcpTool('playwright_browser_snapshot', {});
      return typeof snapshot?.content === 'string' ? snapshot.content : JSON.stringify(snapshot);
    }

    case 'take_screenshot': {
      if (!context.executeMcpTool) {
        return 'Error: Browser tools are not available in this context.';
      }
      const result = await context.executeMcpTool('playwright_browser_take_screenshot', {
        type: 'jpeg',
        fullPage: args.full_page || false
      });
      // The Playwright MCP returns the image in result.raw.content as an image block.
      // Surface it as a structured image result so the agent loop can feed the actual
      // pixels back to the model — otherwise the model is blind to what it captured.
      const imageContent = (result?.raw?.content as any[])?.find((c: any) => c?.type === 'image');
      if (imageContent?.data) {
        return { kind: 'image', mediaType: imageContent.mimeType || 'image/jpeg', data: imageContent.data };
      }
      // No image came back — fall back to whatever text the MCP provided.
      return typeof result?.content === 'string' ? result.content : 'Screenshot taken, but no image data was returned.';
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ─── Context Management ─────────────────────────────────────────────────────

/**
 * Truncate a tool result to prevent context window bloat.
 * Preserves the beginning and end of the content with a truncation notice.
 */
function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const keepChars = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
  return (
    content.substring(0, keepChars) +
    `\n\n... [TRUNCATED: ${content.length} chars total, showing first and last ${keepChars} chars] ...\n\n` +
    content.substring(content.length - keepChars)
  );
}

/**
 * Trim older tool results in the message history to keep context manageable.
 * Keeps the last 3 tool_result blocks at full size, truncates older ones to 2000 chars.
 * Works with Anthropic message format where tool results are in user messages.
 */
function trimMessageHistory(messages: Anthropic.MessageParam[]): void {
  // Find all user messages that contain tool_result blocks
  const toolResultLocations: { msgIdx: number; blockIdx: number }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
          toolResultLocations.push({ msgIdx: i, blockIdx: j });
        }
      }
    }
  }

  // Keep last 3 tool results intact, truncate older ones aggressively
  const preserveCount = 3;
  const truncateLimit = 2000;
  if (toolResultLocations.length > preserveCount) {
    const toTruncate = toolResultLocations.slice(0, toolResultLocations.length - preserveCount);
    for (const loc of toTruncate) {
      const msg = messages[loc.msgIdx];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const block = msg.content[loc.blockIdx] as any;
        if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > truncateLimit) {
          block.content = block.content.substring(0, truncateLimit) + `\n... [trimmed from ${block.content.length} chars]`;
        }
      }
    }
  }
}

// ─── Bedrock Client ─────────────────────────────────────────────────────────

let bedrockClient: AnthropicBedrock | null = null;

function getBedrockClient(): AnthropicBedrock {
  if (!bedrockClient) {
    bedrockClient = new AnthropicBedrock({
      awsRegion: 'us-west-2',
    });
  }
  return bedrockClient;
}

// Exported for testing (allows mock injection)
export function _setBedrockClientForTest(client: AnthropicBedrock | null): void {
  bedrockClient = client;
}

// ─── Vertex Client (native Anthropic format) ──────────────────────────────────
// Claude models on Google Vertex AI (e.g. "claude-sonnet-4-6") are addressed by a
// bare model id with NO "anthropic." prefix. We hit the rawPredict endpoint
// directly, which speaks the native Anthropic Messages format — the exact shape
// the coding agent already builds — so no request/response conversion is needed
// (unlike agentModeService, which adapts to/from OpenAI format).

/** Minimal client surface the agent loop relies on — satisfied by both AnthropicBedrock and the Vertex wrapper. */
interface AnthropicLikeClient {
  messages: {
    create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  };
}

const VERTEX_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per request

let vertexClient: AnthropicLikeClient | null = null;
let vertexClientPromise: Promise<AnthropicLikeClient> | null = null;

async function getVertexClient(): Promise<AnthropicLikeClient> {
  if (vertexClient) return vertexClient;
  if (vertexClientPromise) return vertexClientPromise;

  vertexClientPromise = (async () => {
    const { GoogleAuth } = await import('google-auth-library');
    const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    const secretString = await getSecret(`${environment}/AgentWeb/Google/Vertex`);
    const credentials = JSON.parse(secretString);
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const projectId = credentials.project_id;

    const client: AnthropicLikeClient = {
      messages: {
        create: async (params) => {
          const token = await auth.getAccessToken();
          // The model id goes in the URL for Vertex; everything else is the
          // native Anthropic request body (system, tools, messages, max_tokens).
          const { model, ...rest } = params as any;
          delete (rest as any).model;
          const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/anthropic/models/${model}:rawPredict`;
          const body = { anthropic_version: 'vertex-2023-10-16', ...rest };

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), VERTEX_REQUEST_TIMEOUT_MS);
          let response: Response;
          try {
            response = await fetch(url, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
          } catch (err: any) {
            // Surface a per-request timeout honestly rather than letting the bare
            // AbortError bubble up as a generic (and unretried) failure.
            if (err?.name === 'AbortError') {
              const timeoutErr: any = new Error(
                `Vertex AI request timed out after ${VERTEX_REQUEST_TIMEOUT_MS / 1000}s`
              );
              timeoutErr.status = 408;
              timeoutErr.isTimeout = true;
              throw timeoutErr;
            }
            throw err;
          } finally {
            clearTimeout(timeout);
          }

          if (!response.ok) {
            const errText = await response.text();
            const err: any = new Error(`Vertex AI error ${response.status}: ${errText}`);
            err.status = response.status; // lets callWithRetry decide whether to retry
            throw err;
          }

          // rawPredict returns a native Anthropic Message — consumed as-is.
          return (await response.json()) as Anthropic.Message;
        },
      },
    };

    vertexClient = client;
    return client;
  })();

  return vertexClientPromise;
}

// Exported for testing (allows mock injection)
export function _setVertexClientForTest(client: AnthropicLikeClient | null): void {
  vertexClient = client;
  vertexClientPromise = null;
}

// ─── Bedrock bearer-token client (Opus 4.8, native Anthropic format) ──────────
// Opus 4.8 lives in a separate AWS account (231030591963) the app's default IAM
// credentials can't reach, so it can't use the AnthropicBedrock SDK (SigV4). We
// authenticate with a long-term Bedrock API key (bearer token) and hit the
// invoke endpoint directly — it speaks native Anthropic Messages format, exactly
// what the coding agent already builds.
// App model id -> Bedrock invoke-endpoint profile id, for the models served from
// the separate bearer-token account (231030591963).
const BEARER_TOKEN_INVOKE_MODELS: Record<string, string> = {
  'anthropic.claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
};

// Idle (inter-chunk) timeout for the streaming bearer path. Because we stream,
// we don't need a hard cap on total request duration — a long-but-progressing
// generation is healthy. We only abort if the model goes silent for this long,
// which is the real signature of a hung request. This is what makes the overall
// AGENT_TIMEOUT_MS budget usable: slow turns finish instead of being guillotined.
const BEARER_STREAM_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes of no stream activity

/**
 * Parse AWS `application/vnd.amazon.eventstream` framing out of a growing byte
 * buffer. Each frame is: [totalLen:4][headersLen:4][preludeCRC:4][headers][payload][msgCRC:4],
 * all big-endian. We only need string-valued headers (`:message-type`,
 * `:event-type`, `:exception-type`), so header parsing handles the string type (7).
 * Mutates `state.buf`, yielding one `{ headers, payload }` per complete frame.
 * Exported for unit testing the binary parser without a live socket.
 */
export function* _parseEventStreamFrames(
  state: { buf: Buffer },
  chunk: Uint8Array
): Generator<{ headers: Record<string, string>; payload: Buffer }> {
  state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : Buffer.from(chunk);
  while (state.buf.length >= 12) {
    const totalLen = state.buf.readUInt32BE(0);
    if (totalLen < 16 || state.buf.length < totalLen) break; // incomplete frame — wait for more
    const headersLen = state.buf.readUInt32BE(4);
    const headers: Record<string, string> = {};
    let o = 12;
    const headersEnd = 12 + headersLen;
    while (o < headersEnd) {
      const nameLen = state.buf.readUInt8(o); o += 1;
      const name = state.buf.toString('utf8', o, o + nameLen); o += nameLen;
      const type = state.buf.readUInt8(o); o += 1;
      if (type === 7) { // string header — the only type Bedrock emits for these events
        const vl = state.buf.readUInt16BE(o); o += 2;
        headers[name] = state.buf.toString('utf8', o, o + vl); o += vl;
      } else {
        break; // unexpected header type — stop parsing this frame's headers defensively
      }
    }
    const payload = state.buf.subarray(headersEnd, totalLen - 4);
    state.buf = state.buf.subarray(totalLen);
    yield { headers, payload: Buffer.from(payload) };
  }
}

/**
 * Reconstruct a complete `Anthropic.Message` from a Bedrock streaming response
 * body. Bedrock wraps each native Anthropic streaming event in an eventstream
 * frame whose JSON payload has a base64 `bytes` field. We decode those into the
 * standard event sequence (message_start → content_block_* → message_delta →
 * message_stop) and fold them back into the same non-streaming Message shape the
 * agent loop already consumes — so callers can't tell streaming was used.
 *
 * Resets `onActivity()` on every chunk so the caller can implement an idle timeout.
 * Exported for unit testing the accumulator against synthetic frames.
 */
export async function _accumulateBedrockStream(
  body: ReadableStream<Uint8Array>,
  profileId: string,
  onActivity: () => void
): Promise<Anthropic.Message> {
  const reader = body.getReader();
  const state = { buf: Buffer.alloc(0) };
  let message: any = null;
  const jsonBufs: Record<number, string> = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      if (!value) continue;
      for (const frame of _parseEventStreamFrames(state, value)) {
        const messageType = frame.headers[':message-type'];
        let payload: any;
        try {
          payload = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          continue; // non-JSON frame — ignore
        }
        // Error frames from Bedrock arrive as exceptions, not event chunks.
        if (messageType === 'exception' || messageType === 'error' || frame.headers[':exception-type']) {
          const err: any = new Error(
            `Bedrock (${profileId}) stream error: ${frame.headers[':exception-type'] || ''} ${JSON.stringify(payload)}`.trim()
          );
          // Bedrock surfaces throttling as a stream exception; treat it as retryable.
          err.status = /throttl|TooManyRequests|ServiceUnavailable/i.test(JSON.stringify(frame.headers) + JSON.stringify(payload)) ? 429 : 500;
          throw err;
        }
        if (!payload.bytes) continue;
        const event = JSON.parse(Buffer.from(payload.bytes, 'base64').toString('utf8'));
        switch (event.type) {
          case 'message_start':
            message = { ...event.message, content: [] };
            break;
          case 'content_block_start':
            if (message) { message.content[event.index] = { ...event.content_block }; jsonBufs[event.index] = ''; }
            break;
          case 'content_block_delta':
            if (!message) break;
            if (event.delta?.type === 'text_delta') {
              message.content[event.index].text = (message.content[event.index].text || '') + event.delta.text;
            } else if (event.delta?.type === 'input_json_delta') {
              jsonBufs[event.index] = (jsonBufs[event.index] || '') + event.delta.partial_json;
            }
            break;
          case 'content_block_stop':
            if (message?.content[event.index]?.type === 'tool_use') {
              const raw = jsonBufs[event.index];
              message.content[event.index].input = raw ? JSON.parse(raw) : {};
            }
            break;
          case 'message_delta':
            if (!message) break;
            if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
            if (event.delta?.stop_sequence !== undefined) message.stop_sequence = event.delta.stop_sequence;
            if (event.usage) message.usage = { ...message.usage, ...event.usage };
            break;
          // message_stop carries only Bedrock metrics — nothing to fold in.
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  if (!message) {
    const err: any = new Error(`Bedrock (${profileId}) stream ended without a message_start event`);
    err.status = 500; // treat an empty/garbled stream as a retryable server error
    throw err;
  }
  // Drop any holes left by sparse indexing so downstream sees a dense content array.
  message.content = (message.content as any[]).filter(Boolean);
  return message as Anthropic.Message;
}

let bedrockBearerClient: AnthropicLikeClient | null = null;
let bedrockBearerClientPromise: Promise<AnthropicLikeClient> | null = null;

async function getBedrockBearerClient(): Promise<AnthropicLikeClient> {
  if (bedrockBearerClient) return bedrockBearerClient;
  if (bedrockBearerClientPromise) return bedrockBearerClientPromise;

  bedrockBearerClientPromise = (async () => {
    const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    const bearerToken = (await getSecret(`${environment}/AgentWeb/Bedrock/ApiKey`)).trim();
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';

    const client: AnthropicLikeClient = {
      messages: {
        create: async (params) => {
          // The model id goes in the URL for the Bedrock invoke endpoint; the rest
          // is the native Anthropic request body, with the required version field.
          // We stream (invoke-with-response-stream) rather than block on a single
          // /invoke call: a long generation no longer ties up the whole turn, and a
          // genuinely stuck request is caught by the idle timeout below.
          const { model, ...rest } = params as any;
          delete (rest as any).model;
          const profileId = BEARER_TOKEN_INVOKE_MODELS[model] ?? model;
          const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${profileId}/invoke-with-response-stream`;
          const body = { anthropic_version: 'bedrock-2023-05-31', ...rest };

          // Idle timeout: abort only if the stream goes silent. Reset on every chunk.
          const controller = new AbortController();
          let idleTimer: NodeJS.Timeout | undefined;
          const armIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => controller.abort(), BEARER_STREAM_IDLE_TIMEOUT_MS);
          };
          const clearIdleTimer = () => { if (idleTimer) clearTimeout(idleTimer); };
          armIdleTimer();

          let response: Response;
          try {
            response = await fetch(url, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${bearerToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.amazon.eventstream',
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
          } catch (err: any) {
            clearIdleTimer();
            // Distinguish an idle-timeout abort from other network errors so it's
            // reported honestly instead of being swallowed as a generic failure.
            if (err?.name === 'AbortError') {
              const timeoutErr: any = new Error(
                `Bedrock (${profileId}) request timed out after ${BEARER_STREAM_IDLE_TIMEOUT_MS / 1000}s of inactivity`
              );
              timeoutErr.status = 408; // request timeout — not auto-retried by callWithRetry
              timeoutErr.isTimeout = true;
              throw timeoutErr;
            }
            throw err;
          }

          if (!response.ok) {
            clearIdleTimer();
            const errText = await response.text();
            const err: any = new Error(`Bedrock (${profileId}) error ${response.status}: ${errText}`);
            err.status = response.status; // lets callWithRetry decide whether to retry
            throw err;
          }
          if (!response.body) {
            clearIdleTimer();
            const err: any = new Error(`Bedrock (${profileId}) returned no response body`);
            err.status = 500;
            throw err;
          }

          try {
            return await _accumulateBedrockStream(response.body, profileId, armIdleTimer);
          } catch (err: any) {
            if (err?.name === 'AbortError') {
              const timeoutErr: any = new Error(
                `Bedrock (${profileId}) stream stalled after ${BEARER_STREAM_IDLE_TIMEOUT_MS / 1000}s of inactivity`
              );
              timeoutErr.status = 408;
              timeoutErr.isTimeout = true;
              throw timeoutErr;
            }
            throw err;
          } finally {
            clearIdleTimer();
          }
        },
      },
    };

    bedrockBearerClient = client;
    return client;
  })();

  return bedrockBearerClientPromise;
}

// Exported for testing (allows mock injection)
export function _setBedrockBearerClientForTest(client: AnthropicLikeClient | null): void {
  bedrockBearerClient = client;
  bedrockBearerClientPromise = null;
}

/**
 * Pick the right LLM client for a given model id.
 * - "anthropic.claude-opus-4-8" is on AWS Bedrock in a separate account (bearer-token auth).
 * - Bare "claude-*" ids (e.g. claude-sonnet-*) are Google Vertex AI models.
 * - Other "anthropic.*" ids are AWS Bedrock models (default IAM credentials).
 */
async function getClientForModel(model: string): Promise<AnthropicLikeClient> {
  if (model in BEARER_TOKEN_INVOKE_MODELS) {
    return getBedrockBearerClient();
  }
  if (model.startsWith('claude-')) {
    return getVertexClient();
  }
  return getBedrockClient() as unknown as AnthropicLikeClient;
}

// Sleep helper — injectable for tests to skip real delays
let _sleepFn: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export function _setSleepFnForTest(fn: (ms: number) => Promise<void>): void {
  _sleepFn = fn;
}

/**
 * Call the Anthropic Messages API with retry logic for transient errors.
 * Maps model IDs to inference profile ARNs when needed.
 */
async function callWithRetry(
  client: AnthropicLikeClient,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  // Map Bedrock model IDs to inference profile ARNs for models that require them.
  // Vertex models (bare "claude-*") are not in this map and pass through unchanged —
  // the Vertex client puts the model id in the request URL.
  const inferenceProfileMap: Record<string, string> = {
    'anthropic.claude-sonnet-4-5-20250929-v1:0': 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'anthropic.claude-sonnet-4-6': 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
    'anthropic.claude-opus-4-6-v1': 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-opus-4-6-v1',
  };

  // Use inference profile ARN if available, otherwise use model ID as-is
  const actualModel = inferenceProfileMap[params.model] || params.model;
  const updatedParams = { ...params, model: actualModel };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(updatedParams);
    } catch (error) {
      // Retry transient errors (rate limits / server errors) from either provider.
      const status = (error as any)?.status;
      if (typeof status === 'number' && (status === 429 || status >= 500)) {
        lastError = error as Error;
        // Exponential backoff: 1s, 2s
        await _sleepFn(1000 * Math.pow(2, attempt));
        continue;
      }
      throw error; // Non-retryable error
    }
  }
  throw lastError!;
}

// ─── Failure Summary ─────────────────────────────────────────────────────────

/**
 * Extract a structured summary from the agent's message history
 * so the parent agent knows what happened when max iterations is hit.
 */
function extractFailureSummary(
  messages: Anthropic.MessageParam[],
  maxIterations: number
): { message: string; previewUrl?: string } {
  const toolsCalled: string[] = [];
  const filesEdited: string[] = [];
  let previewUrl: string | undefined;
  let lastAgentText = '';

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolsCalled.push(block.name);
          const input = block.input as any;
          if (block.name === 'edit_file' && input?.file_path) {
            if (!filesEdited.includes(input.file_path)) {
              filesEdited.push(input.file_path);
            }
          }
          if (block.name === 'browse_page' && input?.url) {
            previewUrl = input.url;
          }
        }
        if (block.type === 'text' && 'text' in block) {
          lastAgentText = block.text;
        }
      }
    }
    // Check tool results for preview URLs
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
          const content = (block as any).content;
          if (typeof content === 'string') {
            const urlMatch = content.match(/https:\/\/[^\s"]+\.vercel\.app[^\s"]*/);
            if (urlMatch) previewUrl = urlMatch[0];
          }
        }
      }
    }
  }

  const parts: string[] = [
    `Coding agent hit the iteration limit (${maxIterations}).`,
  ];

  if (filesEdited.length > 0) {
    parts.push(`Files edited: ${filesEdited.join(', ')}.`);
  } else {
    parts.push('No files were edited.');
  }

  if (previewUrl) {
    parts.push(`Preview: ${previewUrl}`);
  }

  // Summarize tool call pattern
  if (toolsCalled.length > 0) {
    const counts: Record<string, number> = {};
    for (const t of toolsCalled) counts[t] = (counts[t] || 0) + 1;
    const summary = Object.entries(counts)
      .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
      .join(', ');
    parts.push(`Activity: ${summary}.`);
  }

  if (lastAgentText) {
    const truncated = lastAgentText.length > 200
      ? lastAgentText.substring(0, 200) + '...'
      : lastAgentText;
    parts.push(`Last agent note: "${truncated}"`);
  }

  return { message: parts.join(' '), previewUrl };
}

/**
 * Resolve the editable boundary for a run from the page record and the owner's
 * other pages that share the same repo (a multi-route project = many page
 * records, one repo). Best-effort: any failure (missing record, DB error)
 * returns undefined so the agent runs unrestricted rather than blocking all
 * edits on a lookup hiccup.
 */
async function resolvePageScopeForContext(
  context: CodingAgentContext
): Promise<PageScope | undefined> {
  try {
    const page = await getLandingPageById(context.pageId);
    if (!page) return undefined;
    let repoPages: GeneratedLandingPage[] = [page];
    try {
      const ownerPages = await getLandingPagesByOwner(page.userId);
      if (ownerPages.length > 0) repoPages = ownerPages;
    } catch (e) {
      // Couldn't list the owner's pages — scope to just this page (still yields a
      // valid repo-wide scope, only without the sibling route slugs for the prompt).
      console.warn('[CODING AGENT] Could not list owner pages for scope; using page alone:', e);
    }
    return resolvePageScope(page, repoPages);
  } catch (e) {
    console.warn('[CODING AGENT] Page scope resolution failed; running unrestricted:', e);
    return undefined;
  }
}

// ─── Main Agent Loop ────────────────────────────────────────────────────────

async function runCodingAgentInternal(
  taskDescription: string,
  context: CodingAgentContext,
  maxIterations: number,
  model: string,
  usageAcc: CodingAgentUsageAccumulator
): Promise<CodingAgentResult> {

  const client = await getClientForModel(model);
  const tools = getToolDefinitions();

  // Resolve this run's editable boundary so a single-page task can't bleed edits
  // into sibling pages that share the same repo. Best-effort: if lookup fails we
  // leave scope unset and the agent runs unrestricted (prior behavior) rather
  // than blocking all work. An explicit context.scope (e.g. from the eval harness)
  // takes precedence; otherwise resolve from the page record.
  const scope = context.scope ?? (await resolvePageScopeForContext(context));
  // Thread the resolved scope through to executeTool's write guard without
  // mutating the caller's context object.
  const scopedContext: CodingAgentContext = { ...context, scope };

  // Pre-fetch the file listing so the agent knows the repo structure from the first iteration.
  // This prevents it from blindly guessing file paths (e.g. editing index.html instead of app/page.tsx).
  // The full repo is shown — all route directories and shared files — because a
  // multi-route project lives in one repo and edits may legitimately span routes.
  let fileListingPreamble = '';
  try {
    const fileList = await executeTool('list_files', {}, scopedContext);
    fileListingPreamble = `\n\n## Repository file listing (use this to orient yourself — do not call list_files again)\n\`\`\`\n${typeof fileList === 'string' ? fileList : ''}\n\`\`\`\n\n`;
  } catch (e) {
    if (is403Error(e)) throw e; // Authorization failure — propagate immediately
    // Non-fatal: agent can still call list_files itself
    console.warn('[CODING AGENT] Pre-fetch of file listing failed, agent will list files manually:', e);
  }

  // Append the strict scope rules to the system prompt for this run.
  const systemPrompt = scope
    ? CODING_AGENT_SYSTEM_PROMPT + buildScopeSystemClause(scope)
    : CODING_AGENT_SYSTEM_PROMPT;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: fileListingPreamble + taskDescription }
  ];

  let iteration = 0;
  const editedFiles = new Set<string>();

  try {
    while (iteration < maxIterations) {
      throwIfAborted(context.abortSignal);
      iteration++;

      // Trim older messages every 5 iterations to prevent context bloat
      if (iteration > 1 && iteration % 5 === 0) {
        trimMessageHistory(messages);
      }

      // Emit progress
      if (context.socketEmit) {
        context.socketEmit(context.sessionId, 'coding-agent-progress', {
          type: 'iteration',
          iteration,
          totalMax: maxIterations
        });
      }

      // Call Anthropic Messages API
      const response = await callWithRetry(client, {
        model,
        max_tokens: 16384,
        system: systemPrompt,
        tools,
        messages,
      });
      throwIfAborted(context.abortSignal);

      // Report this turn's token usage if a consumer is listening (eval harness).
      if (context.onUsage && response.usage) {
        context.onUsage(response.usage as any);
      }

      // Shadow-meter every turn's spend. The coding loop can run many high-cost
      // Bedrock/Claude iterations, so leaving it unmetered was the biggest hole in
      // per-user cost data. Fire-and-forget + fail-open: never blocks/slows the run.
      try {
        const u: any = response.usage;
        if (u) {
          // Accumulate for the per-user cap (charged once by the caller from
          // result.usageTotals). Same numbers the shadow meter records below.
          usageAcc.inputTokens += u.input_tokens || 0;
          usageAcc.outputTokens += u.output_tokens || 0;
          usageAcc.cacheReadTokens += u.cache_read_input_tokens || 0;
          usageAcc.cacheWriteTokens += u.cache_creation_input_tokens || 0;
          void recordUsage({
            userId: context.userId,
            sessionId: context.sessionId,
            model,
            provider: model.startsWith('claude-') ? 'vertex' : 'bedrock',
            feature: 'coding_agent',
            inputTokens: u.input_tokens || 0,
            outputTokens: u.output_tokens || 0,
            cacheReadTokens: u.cache_read_input_tokens || 0,
            cacheWriteTokens: u.cache_creation_input_tokens || 0,
          });
        }
      } catch {
        // Metering must never break the coding loop.
      }

      // Add assistant message to history
      messages.push({ role: 'assistant', content: response.content });

      // If no tool use, the LLM is done — return its text
      if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') {
        const textBlock = response.content.find(b => b.type === 'text');
        return {
          success: true,
          message: textBlock && 'text' in textBlock ? textBlock.text : 'Coding agent completed without a report.',
          iterations: iteration
        };
      }

      // Extract tool_use blocks
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        if (block.type !== 'tool_use') continue;

        const fnName = block.name;
        const fnArgs = block.input as any;

        // Check for terminal tool
        if (fnName === 'report_to_user') {
          const status = fnArgs.status || 'success';
          return {
            success: status === 'success',
            message: fnArgs.message || 'Done.',
            iterations: iteration,
            previewUrl: fnArgs.preview_url,
            branch: context.draftBranch,
            editedFiles: Array.from(editedFiles),
          };
        }

        // Execute the tool
        let toolResult: string | ToolImageResult;
        try {
          throwIfAborted(context.abortSignal);
          toolResult = await executeTool(fnName, fnArgs, scopedContext);
          if (fnName === 'edit_file' && fnArgs.file_path && typeof toolResult === 'string' && !/^Failed to apply edits|^Error:/i.test(toolResult)) {
            editedFiles.add(fnArgs.file_path);
          }
          if (fnName === 'edit_files' && Array.isArray(fnArgs.files) && typeof toolResult === 'string' && !/^Error:/i.test(toolResult)) {
            // ENG-497 / Greptile: batch commits must be tracked too, or a failed
            // deployment/acceptance check after this can't roll them back.
            for (const f of fnArgs.files) {
              if (f?.file_path) editedFiles.add(f.file_path);
            }
          }

          // Emit progress about tool execution
          if (context.socketEmit) {
            context.socketEmit(context.sessionId, 'coding-agent-progress', {
              type: 'tool_executed',
              iteration,
              tool: fnName,
              filePath: fnArgs.file_path
            });
          }
        } catch (error) {
          if (is403Error(error)) throw error; // Authorization failure — exit loop immediately
          if (isAbortError(error)) throw error;
          toolResult = `Error executing ${fnName}: ${error instanceof Error ? error.message : String(error)}`;
        }

        if (isToolImageResult(toolResult)) {
          // Feed the screenshot back as a vision input so the model can actually see it
          // and verify visual correctness (mirrors the main agent-mode loop).
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: [
              { type: 'text', text: 'Screenshot captured. Analyze the image below to verify the result visually.' },
              { type: 'image', source: { type: 'base64', media_type: toolResult.mediaType as any, data: toolResult.data } }
            ]
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: truncateToolResult(toolResult)
          });
        }
      }

      // Add tool results as a user message
      messages.push({ role: 'user', content: toolResults });
    }

    // Max iterations reached — extract useful context for the parent agent
    const summary = extractFailureSummary(messages, maxIterations);
    return {
      success: false,
      message: summary.message,
      iterations: iteration,
      previewUrl: summary.previewUrl,
      branch: context.draftBranch,
      editedFiles: Array.from(editedFiles),
    };

  } catch (error) {
    if (isAbortError(error)) {
      return {
        success: false,
        message: 'Coding agent run was cancelled before completion.',
        iterations: iteration,
        branch: context.draftBranch,
        editedFiles: Array.from(editedFiles),
      };
    }
    if (is403Error(error)) {
      return {
        success: false,
        message: NOT_AUTHORIZED_MESSAGE,
        iterations: iteration,
        notAuthorized: true,
        editedFiles: Array.from(editedFiles),
      };
    }
    return {
      success: false,
      message: `Coding agent encountered an error: ${error instanceof Error ? error.message : String(error)}`,
      iterations: iteration,
      branch: context.draftBranch,
      editedFiles: Array.from(editedFiles),
    };
  }
}

/**
 * Run the coding agent with a timeout wrapper.
 * Ensures the agent doesn't run indefinitely if tools hang.
 */
export async function runCodingAgent(
  taskDescription: string,
  context: CodingAgentContext,
  maxIterations: number = DEFAULT_MAX_ITERATIONS
): Promise<CodingAgentResult> {
  const run = await createCodingAgentRun({
    sessionId: context.sessionId,
    pageId: context.pageId,
    userId: context.userId,
    branch: context.draftBranch,
  });
  const abortController = new AbortController();
  const runContext: CodingAgentContext = {
    ...context,
    runId: run.runId,
    abortSignal: abortController.signal,
  };

  // Filled by runCodingAgentInternal's loop; read once here to charge the caller.
  const usageAcc: CodingAgentUsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  const withRun = (result: CodingAgentResult, state?: CodingAgentRunState): CodingAgentResult => {
    const totalTokens =
      usageAcc.inputTokens + usageAcc.outputTokens + usageAcc.cacheReadTokens + usageAcc.cacheWriteTokens;
    // `model` is only accessed here (in the totalTokens > 0 branch), which cannot
    // be reached until the loop has run — i.e. after model resolution below — so
    // there is no temporal-dead-zone hazard on the early-return paths (auth denial,
    // preview-branch reset failure) where no LLM call was made.
    const usageTotals =
      totalTokens > 0
        ? {
            inputTokens: usageAcc.inputTokens,
            outputTokens: usageAcc.outputTokens,
            cacheReadTokens: usageAcc.cacheReadTokens,
            cacheWriteTokens: usageAcc.cacheWriteTokens,
            totalTokens,
            costUsd:
              computeCostMicroUsd(
                model,
                usageAcc.inputTokens,
                usageAcc.outputTokens,
                usageAcc.cacheReadTokens,
                usageAcc.cacheWriteTokens
              ) / 1e6,
          }
        : undefined;
    return {
      ...result,
      runId: run.runId,
      state: state || result.state,
      branch: result.branch ?? context.draftBranch,
      usageTotals: result.usageTotals ?? usageTotals,
    };
  };

  // Preflight authorization. The page may be org-visible (so the agent could
  // see and select it) yet not editable by this caller — a plain member can
  // view a shared page but only the owner / listed editors can edit it. Checking
  // up front means a denied caller gets one clear, actionable message instead of
  // the LLM loop spinning up, hitting a 403 on the first write, and the parent
  // agent retrying coding_agent several times (the failure mode this fixes).
  // Best-effort: if the page record is missing we skip the check and let the
  // edit path enforce authorization as before.
  try {
    await updateCodingAgentRun(run.runId, { state: 'authorizing' });
    const page = await getLandingPageById(context.pageId);
    if (page && !(await canUserEditLandingPage(page, context.userId))) {
      await updateCodingAgentRun(run.runId, {
        state: 'failed',
        failureReason: NOT_AUTHORIZED_MESSAGE,
        transitionReason: 'authorization_denied',
      });
      return withRun({
        success: false,
        message: NOT_AUTHORIZED_MESSAGE,
        iterations: 0,
        notAuthorized: true,
        retryable: false,
      }, 'failed');
    }
  } catch (e) {
    console.warn('[CODING AGENT] Preflight authorization check failed; proceeding to edit path:', e);
  }

  try {
    await resetReusablePreviewBranchToMain(runContext);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateCodingAgentRun(run.runId, {
      state: 'failed',
      failureReason: message,
      transitionReason: 'preview_branch_reset_failed',
    });
    return withRun({
      success: false,
      message,
      iterations: 0,
      retryable: true,
    }, 'failed');
  }

  const shouldCaptureBaseCommit =
    process.env.NODE_ENV !== 'test' || process.env.CODING_AGENT_CAPTURE_BASE_COMMIT_TEST === 'true';
  const baseCommitSha = shouldCaptureBaseCommit ? await getCurrentCommitSha(runContext) : undefined;
  await updateCodingAgentRun(run.runId, {
    state: 'editing',
    baseCommitSha,
    recovery: { status: 'not_needed', baseCommitSha },
  });

  // Fetch the coding agent model from settings (defaults to Sonnet 4.6)
  let model: string;
  try {
    model = await agentModeService.getCodingAgentDefaultModel();
  } catch (error) {
    console.error('Error fetching coding agent model from settings, using fallback:', error);
    model = DEFAULT_CODING_AGENT_MODEL;
  }

  let timeoutTimer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<CodingAgentResult>((resolve) => {
    timeoutTimer = setTimeout(() => {
      abortController.abort();
      resolve({
        success: false,
        message: 'Coding agent timed out after 10 minutes. The run was cancelled; check the recorded draft branch for any recoverable partial work.',
        iterations: -1,
        runId: run.runId,
        state: 'timed_out',
        branch: context.draftBranch,
        baseCommitSha,
        acceptanceStatus: context.acceptanceChecks?.length ? 'not_run' : undefined,
        retryable: true,
      });
    }, AGENT_TIMEOUT_MS);
    timeoutTimer.unref?.();
  });

  let rawResult: CodingAgentResult;
  try {
    rawResult = await Promise.race<CodingAgentResult>([
      runCodingAgentInternal(taskDescription, runContext, maxIterations, model, usageAcc).catch((error) => {
        if (is403Error(error)) {
          return {
            success: false,
            message: NOT_AUTHORIZED_MESSAGE,
            iterations: 0,
            notAuthorized: true,
            acceptanceStatus: context.acceptanceChecks?.length ? 'not_run' : undefined,
            retryable: false,
          } satisfies CodingAgentResult;
        }
        if (isAbortError(error)) {
          return {
            success: false,
            message: 'Coding agent run was cancelled.',
            iterations: 0,
            state: abortController.signal.aborted ? 'timed_out' : 'cancelled',
            acceptanceStatus: context.acceptanceChecks?.length ? 'not_run' : undefined,
            retryable: true,
          } satisfies CodingAgentResult;
        }
        throw error;
      }),
      timeoutPromise
    ]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  if (rawResult.state === 'timed_out') {
    await updateCodingAgentRun(run.runId, {
      state: 'timed_out',
      failureReason: rawResult.message,
      recovery: {
        attempted: false,
        status: 'not_needed',
        reason: 'Run timed out and was cancelled before a stable successful result.',
        baseCommitSha,
      },
      transitionReason: 'timeout',
    });
    return withRun(rawResult, 'timed_out');
  }

  let result = withRun({ ...rawResult, baseCommitSha }, rawResult.success ? 'deploying' : 'failed');
  await updateCodingAgentRun(run.runId, {
    state: result.success ? 'deploying' : 'failed',
    previewUrl: result.previewUrl,
    failureReason: result.success ? undefined : result.message,
    transitionReason: result.success ? 'agent_reported_success' : 'agent_reported_failure',
  });

  const refresh = await refreshPreviewUrlForDraftBranchStrict(result, runContext);
  result = refresh.result;
  if (refresh.blockedReason && context.acceptanceChecks?.length) {
    const blocked: AcceptanceVerificationResult = {
      status: 'blocked',
      checks: [{
        id: 'preview_refresh',
        type: 'http_status',
        label: 'Preview URL refresh',
        status: 'blocked',
        message: refresh.blockedReason,
      }],
      summary: 'Acceptance blocked (1/1 checks could not run).',
    };
    await updateCodingAgentRun(run.runId, {
      state: 'blocked',
      previewUrl: result.previewUrl,
      verification: blocked,
      failureReason: refresh.blockedReason,
      transitionReason: 'preview_refresh_failed',
    });
    return withRun({
      ...result,
      success: false,
      state: 'blocked',
      acceptanceStatus: 'blocked',
      acceptance: blocked,
      verification: blocked,
      retryable: true,
      message: `${result.message}\n\n${blocked.summary}\n- Preview URL refresh: ${refresh.blockedReason}`,
    }, 'blocked');
  }

  if (!context.acceptanceChecks?.length) {
    const state: CodingAgentRunState = result.success ? 'passed' : 'failed';
    await updateCodingAgentRun(run.runId, {
      state,
      previewUrl: result.previewUrl,
      failureReason: result.success ? undefined : result.message,
      recovery: { status: 'not_needed', baseCommitSha },
      transitionReason: 'no_acceptance_checks',
    });
    return withRun({ ...result, recovery: { status: 'not_needed', baseCommitSha } }, state);
  }

  if (!result.success) {
    let recovery: CodingAgentRecoveryState = { status: 'not_needed', baseCommitSha };
    let state: CodingAgentRunState = 'failed';
    if (isBuildOrDeploymentFailure(result)) {
      recovery = await rollbackEditedFiles({
        context: runContext,
        baseCommitSha,
        editedFiles: result.editedFiles,
      });
      if (recovery.status === 'succeeded') state = 'rolled_back';
    }
    await updateCodingAgentRun(run.runId, {
      state,
      previewUrl: result.previewUrl,
      failureReason: result.message,
      recovery,
      transitionReason: state === 'rolled_back' ? 'build_failure_rolled_back' : 'agent_failed',
    });
    return withRun({
      ...result,
      state,
      acceptanceStatus: result.acceptanceStatus ?? 'not_run',
      recovery,
      retryable: !result.notAuthorized,
    }, state);
  }

  await updateCodingAgentRun(run.runId, { state: 'verifying', previewUrl: result.previewUrl });
  const acceptance = await verifyAcceptanceChecks({
    checks: context.acceptanceChecks,
    previewUrl: result.previewUrl,
    executeMcpTool: context.executeMcpTool,
    signal: abortController.signal,
  });

  if (acceptance.status !== 'passed') {
    const failedLines = acceptance.checks
      .filter((check) => check.status !== 'passed')
      .map((check) => `- ${check.label}: ${check.message}`)
      .join('\n');
    const state: CodingAgentRunState = acceptance.status === 'blocked' ? 'blocked' : 'failed';
    const recovery: CodingAgentRecoveryState = {
      attempted: false,
      status: 'not_needed',
      reason: 'Draft preview is recoverable; acceptance failure does not auto-rollback.',
      baseCommitSha,
    };
    await updateCodingAgentRun(run.runId, {
      state,
      previewUrl: result.previewUrl,
      verification: acceptance,
      failureReason: acceptance.summary,
      recovery,
      transitionReason: acceptance.status === 'blocked' ? 'verification_blocked' : 'verification_failed',
    });
    return withRun({
      ...result,
      success: false,
      state,
      acceptanceStatus: acceptance.status,
      acceptance,
      verification: acceptance,
      recovery,
      retryable: true,
      message: `${result.message}\n\n${acceptance.summary}${failedLines ? `\n${failedLines}` : ''}`,
    }, state);
  }

  const recovery: CodingAgentRecoveryState = { status: 'not_needed', baseCommitSha };
  await updateCodingAgentRun(run.runId, {
    state: 'passed',
    previewUrl: result.previewUrl,
    verification: acceptance,
    recovery,
    transitionReason: 'verification_passed',
  });
  return withRun({
    ...result,
    state: 'passed',
    acceptanceStatus: 'passed',
    acceptance,
    verification: acceptance,
    recovery,
    retryable: false,
    message: `${result.message}\n\n${acceptance.summary}`,
  }, 'passed');
}
