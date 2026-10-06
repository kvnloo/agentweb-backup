/**
 * ENG-2327: session tracking for landing pages.
 *
 * Two halves:
 *   1. the tracker-session-list creation logic EXTRACTED from routes/tracking.ts
 *      (POST /api/tracking/session-lists, ENG-2315), so that route and the landing-page paths create a
 *      session list through one function and cannot drift apart;
 *   2. enableSessionTrackingForPage / disableSessionTrackingForPage: create-or-reuse the page's session
 *      list, commit the SDK tag into the page's OWN repo through the same rebase-safe commit path
 *      generation and update-files use (commitFilesToRepoMain, org GitHub App token), and record the
 *      result on the landing-page record. See the PR description for the design decisions.
 *
 * Ordering is the safety property: the list is created and recorded BEFORE anything touches the repo,
 * and a page that must be refused (existing tracker, unknown file shape) is refused BEFORE the list
 * is created. If the commit fails, the recorded list stays valid and the retry reuses it.
 */
import axios from 'axios';
import { crmDb } from './db';
import {
  claimLandingPageSessionTrackingList,
  commitFilesToRepoMain,
  getLandingPageById,
  listLandingPages,
  resolveLandingPageLiveUrl,
  updateLandingPageSessionTracking,
  type GeneratedLandingPage,
} from './v0Service';
import { isSessionList } from '../utils/sessionList';
import {
  MAX_ALLOWED_ORIGINS,
  TrackingConfigError,
  normalizeAllowedOrigin,
  normalizePageLabel,
  type TrackingConfig,
} from '../utils/trackingConfig';
import {
  SessionTrackingInjectionError,
  extractInstalledListId,
  findBespokeTrackerRoute,
  findExistingTracker,
  injectSessionTrackingIntoHtml,
  injectSessionTrackingIntoLayout,
  isAutoSessionTrackingEnabled,
  sdkScriptUrl,
  verifySessionTrackingInjection,
  type SessionTrackingTarget,
} from '../utils/sessionTrackingInjection';

/** Columns a session list shows by default (customFields keys written by the ingest). */
export const SESSION_LIST_DISPLAY_FIELDS = [
  'channel', 'trafficType', 'channelGroup', 'sourceDetail', 'dwellSec', 'lastEvent', 'furthestStage', 'visitNo',
];

export function buildEmbedSnippet(listId: string): string {
  return `<script src="${sdkScriptUrl()}" data-aw-list="${listId}" async></script>`;
}

/**
 * Create a system-managed, public session list carrying `trackingConfig` from its first write.
 * The caller validates name/origins/label (the route and the landing-page service each own their
 * own input rules); this only performs the write.
 */
export async function createTrackerSessionList(
  userId: string,
  name: string,
  trackingConfig: TrackingConfig,
): Promise<Record<string, any>> {
  return crmDb.createLeadList(
    userId, name, '',
    [],              // alertEvents: a session row is telemetry, never an owner alert
    null, false, undefined, undefined, undefined,
    'session',
    true,            // isSystemManaged
    undefined,
    // publicAccessEnabled from the first write: the SDK posts anonymously, and ingest refuses a list without it.
    { publicAccessEnabled: true, displayFields: SESSION_LIST_DISPLAY_FIELDS, trackingConfig },
  );
}

// ─── ENG-2327: landing-page enablement ───────────────────────────────────────────────────

export type SessionTrackingFailureCode =
  | 'external_page'
  | 'no_repo'
  | 'invalid_repo'
  | 'not_deployed'
  | 'no_origins'
  | 'no_target_file'
  | 'invalid_path'
  | 'existing_tracker'
  | 'unsupported_shape'
  | 'too_large'
  | 'list_mismatch'
  | 'page_gone'
  | 'repo_too_large'
  | 'too_many_files'
  | 'verify_failed';

/** A refusal or failure the caller can show verbatim; `httpStatus` is what the route answers with. */
export class SessionTrackingError extends Error {
  constructor(
    public readonly code: SessionTrackingFailureCode,
    message: string,
    public readonly httpStatus: number = 422,
  ) {
    super(message);
    this.name = 'SessionTrackingError';
  }
}

export interface EnableSessionTrackingOptions {
  /** Install even though the page carries its own tracker. Only ever set by an explicit caller choice. */
  overrideExistingTracker?: boolean;
  /** Static-HTML page to tag (`public/<name>.html`); default is `public/<slug>.html`, then `public/index.html`. */
  htmlPath?: string;
}

export interface SessionTrackingResult {
  listId: string;
  embedSnippet: string;
  /** The SDK tag is on the repo's main branch (after this call, whether or not this call put it there). */
  installed: boolean;
  /** Nothing had to be committed: the repo already carried exactly this tag. */
  alreadyInstalled: boolean;
  /** The list was created by this call (false = reused). */
  listCreated: boolean;
  /** Repo file the tag lives in. */
  path: string;
  commitUrl?: string;
  allowedOrigins: string[];
}

export { isAutoSessionTrackingEnabled };

const GITHUB_TIMEOUT_MS = 30_000;
/** Most static pages / API routes we will read to look for a tracker; more than this is refused, not guessed. */
const MAX_INSPECTED_FILES = 20;
const MAX_INSPECTED_FILE_BYTES = 900_000;
const MAX_CAS_ATTEMPTS = 3;
const LAYOUT_PATHS = ['app/layout.tsx', 'src/app/layout.tsx'];
const HTML_PATH_RE = /^public\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.html$/;

/** Serialises enablement per repo inside one process: sibling pages share the layout they all edit. */
const repoLocks = new Map<string, Promise<unknown>>();
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  repoLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (repoLocks.get(key) === tail) repoLocks.delete(key);
  }
}

function parseRepo(page: Pick<GeneratedLandingPage, 'githubRepoUrl'>): { repoFullName: string } {
  if (!page.githubRepoUrl) throw new SessionTrackingError('no_repo', 'Landing page has no GitHub repository', 400);
  const m = page.githubRepoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) throw new SessionTrackingError('invalid_repo', 'Invalid GitHub repo URL', 400);
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, '');
  // The repo name goes into API URLs: only characters GitHub itself allows.
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new SessionTrackingError('invalid_repo', 'Invalid GitHub repo URL', 400);
  }
  return { repoFullName: `${owner}/${repo}` };
}

function assertEligible(page: GeneratedLandingPage): void {
  // An imported external record never owned its repo: nothing here may edit it.
  if ((page as any).sourceType === 'external') {
    throw new SessionTrackingError('external_page', 'Imported (external) pages are not managed by AgentWeb; their code cannot be changed from here.', 400);
  }
  if (page.status === 'generating' || page.status === 'deploying' || page.status === 'failed') {
    throw new SessionTrackingError('not_deployed', `Landing page is ${page.status}; enable session tracking once it is deployed.`, 409);
  }
}

/**
 * The exact browser origins a page is served from: its custom/managed domain, its Vercel domain and
 * the live URL Vercel reports for it. https only, exact origins only (no wildcard), de-duplicated and
 * capped. Anything that is not a valid https origin is skipped rather than failing the whole call.
 */
export async function deriveAllowedOrigins(page: GeneratedLandingPage): Promise<string[]> {
  const candidates: Array<string | undefined> = [page.customDomainUrl, page.deployedUrl];
  try {
    candidates.push(await resolveLandingPageLiveUrl(page));
  } catch {
    // resolveLandingPageLiveUrl never throws by contract; a lookup failure just means one fewer candidate.
  }
  const origins: string[] = [];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      const u = new URL(withScheme);
      if (u.protocol !== 'https:') continue;
      const origin = normalizeAllowedOrigin(u.origin);
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      // not a usable origin: skip
    }
    if (origins.length >= MAX_ALLOWED_ORIGINS) break;
  }
  return origins;
}

interface RepoFile {
  path: string;
  content: string;
  target: SessionTrackingTarget;
}

const ghHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' });

function assertSafePath(path: string): void {
  if (path.includes('..') || path.startsWith('.github/') || path.startsWith('/') || path.includes('\\')) {
    throw new SessionTrackingError('invalid_path', `Invalid file path: ${path}`, 400);
  }
}

/** Read one file at a ref. null = the file does not exist (404). Anything else propagates. */
async function readRepoFile(repoFullName: string, headers: Record<string, string>, path: string, ref: string): Promise<string | null> {
  try {
    const res = await axios.get<any>(
      `https://api.github.com/repos/${repoFullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
      { headers, timeout: GITHUB_TIMEOUT_MS },
    );
    if (Array.isArray(res.data) || res.data?.type === 'dir') return null;
    // A file over the Contents API's 1MB read limit comes back without content: never edit what we cannot see whole.
    if (typeof res.data?.content !== 'string' || res.data.encoding === 'none') {
      throw new SessionTrackingError('too_large', `${path} is too large to edit safely`, 422);
    }
    return Buffer.from(res.data.content, 'base64').toString('utf-8');
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

async function readMainSha(repoFullName: string, headers: Record<string, string>): Promise<string> {
  const res = await axios.get<any>(`https://api.github.com/repos/${repoFullName}/git/ref/heads/main`, { headers, timeout: GITHUB_TIMEOUT_MS });
  return res.data.object.sha;
}

/**
 * Find the file that carries (or should carry) the tag, reading main at `ref`:
 *   a Next root layout first, else a static `public/*.html` page, else refuse.
 */
async function locateTarget(
  page: GeneratedLandingPage,
  repoFullName: string,
  headers: Record<string, string>,
  ref: string,
  htmlPath?: string,
): Promise<RepoFile> {
  if (htmlPath !== undefined) {
    assertSafePath(htmlPath);
    if (!HTML_PATH_RE.test(htmlPath)) {
      throw new SessionTrackingError('invalid_path', 'htmlPath must be a .html file under public/', 400);
    }
    const content = await readRepoFile(repoFullName, headers, htmlPath, ref);
    if (content === null) throw new SessionTrackingError('no_target_file', `${htmlPath} was not found in the repository`, 422);
    return { path: htmlPath, content, target: 'html' };
  }
  for (const path of LAYOUT_PATHS) {
    const content = await readRepoFile(repoFullName, headers, path, ref);
    if (content !== null) return { path, content, target: 'layout' };
  }
  const slug = (page.slug || '').replace(/^\/+|\/+$/g, '');
  const htmlCandidates = [...(slug && /^[A-Za-z0-9._-]+$/.test(slug) ? [`public/${slug}.html`] : []), 'public/index.html'];
  for (const path of htmlCandidates) {
    const content = await readRepoFile(repoFullName, headers, path, ref);
    if (content !== null) return { path, content, target: 'html' };
  }
  throw new SessionTrackingError(
    'no_target_file',
    'Could not find app/layout.tsx or a public/*.html page in this repository, so there is nowhere to add the tracking tag.',
    422,
  );
}


/**
 * The located target is not the only file that can carry a tracker. A repo can ship a Next layout AND raw
 * static pages (public/*.html behind rewrites) that never load that layout, with their own tracker and a
 * bespoke track route (the DramaBreak shape). Tagging only the layout there would edit the customer's repo
 * for nothing and double-track nothing it reaches. So, before anything is created, read the whole repo's
 * tracker-bearing files (bounded) and refuse if ANY carries one. Conservative on every bound: a truncated
 * tree, too many files or a file too big to read is a refusal with its own code, never a guess.
 */
async function assertNoTrackerElsewhere(
  repoFullName: string,
  headers: Record<string, string>,
  sha: string,
  alreadyChecked: string,
): Promise<void> {
  const res = await axios.get<any>(`https://api.github.com/repos/${repoFullName}/git/trees/${encodeURIComponent(sha)}?recursive=1`, {
    headers, timeout: GITHUB_TIMEOUT_MS,
  });
  if (res.data?.truncated || !Array.isArray(res.data?.tree)) {
    throw new SessionTrackingError('repo_too_large', 'This repository is too large to check for an existing tracker, so nothing was changed.', 422);
  }
  const blobs: Array<{ path: string; size?: number }> = res.data.tree.filter((e: any) => e?.type === 'blob' && typeof e.path === 'string');
  const htmlFiles = blobs.filter((b) => /^public\/.+\.html?$/i.test(b.path));
  const routeFiles = blobs.filter((b) => /^(?:src\/)?app\/api\/.+\/route\.(?:ts|tsx|js|mjs)$/.test(b.path));
  if (htmlFiles.length > MAX_INSPECTED_FILES || routeFiles.length > MAX_INSPECTED_FILES) {
    throw new SessionTrackingError(
      'too_many_files',
      `This repository has more than ${MAX_INSPECTED_FILES} static pages or API routes to check for an existing tracker, so nothing was changed.`,
      422,
    );
  }
  const refuse = (path: string, found: string): never => {
    throw new SessionTrackingError(
      'existing_tracker',
      `This repository already carries its own tracker (found "${found}" in ${path}). Adding the AgentWeb session tag would ` +
        'count visits twice or tag a layout those pages never load, so nothing was changed. Pass overrideExistingTracker only if you have ' +
        'confirmed the existing tracker is being removed.',
      409,
    );
  };
  for (const [files, isRoute] of [[htmlFiles, false], [routeFiles, true]] as const) {
    for (const f of files) {
      if (f.path === alreadyChecked) continue;
      if (typeof f.size === 'number' && f.size > MAX_INSPECTED_FILE_BYTES) {
        throw new SessionTrackingError('too_large', `${f.path} is too large to check for an existing tracker, so nothing was changed.`, 422);
      }
      const content = await readRepoFile(repoFullName, headers, f.path, sha);
      if (content === null) continue;
      const found = isRoute ? findBespokeTrackerRoute(content) : findExistingTracker(content, 'html');
      if (found) refuse(f.path, found);
    }
  }
}

function injectFor(file: RepoFile, listId: string, override: boolean): string {
  try {
    return file.target === 'layout'
      ? injectSessionTrackingIntoLayout(file.content, listId, { overrideExistingTracker: override })
      : injectSessionTrackingIntoHtml(file.content, listId, { overrideExistingTracker: override });
  } catch (err) {
    if (err instanceof SessionTrackingInjectionError) {
      throw new SessionTrackingError(err.code === 'existing_tracker' ? 'existing_tracker' : err.code === 'too_large' ? 'too_large' : 'unsupported_shape', err.message, err.code === 'existing_tracker' ? 409 : 422);
    }
    throw err;
  }
}

/** A list is reusable for `page` only if it is a session list the page's OWNER owns. */
async function loadOwnedSessionList(listId: string | undefined, ownerId: string): Promise<Record<string, any> | null> {
  if (!listId) return null;
  const list = (await crmDb.getLeadListById(listId)) as Record<string, any> | null | undefined;
  if (!list || !isSessionList(list) || list.userId !== ownerId) return null;
  return list;
}

/** Union the page's current origins into an existing list's allow-list (never removes one; capped). */
async function mergeOrigins(list: Record<string, any>, derived: string[]): Promise<string[]> {
  const current: Partial<TrackingConfig> = list.trackingConfig && typeof list.trackingConfig === 'object' ? list.trackingConfig : {};
  const existing = Array.isArray(current.allowedOrigins) ? current.allowedOrigins : [];
  const merged = [...existing];
  for (const o of derived) if (!merged.includes(o) && merged.length < MAX_ALLOWED_ORIGINS) merged.push(o);
  if (merged.length !== existing.length) {
    await crmDb.updateLeadList(list.listId, { trackingConfig: { ...current, allowedOrigins: merged } });
  }
  return merged;
}

function pageLabelFor(page: GeneratedLandingPage): string | undefined {
  try {
    return normalizePageLabel((page.name || '').trim().slice(0, 60));
  } catch {
    return undefined;
  }
}

/** Re-point every record sharing this repo (the tag is in the shared layout). Best-effort, like the GTM sync. */
async function syncSiblings(page: GeneratedLandingPage, state: { installed: boolean; listId?: string }): Promise<void> {
  try {
    const siblings = await listLandingPages(page.userId);
    await Promise.all(
      siblings
        .filter((p) => p.id !== page.id && p.githubRepoUrl === page.githubRepoUrl && (p as any).sourceType !== 'external')
        .map((p) =>
          updateLandingPageSessionTracking(p.id, state).catch((err: any) => {
            console.error(`[SESSION TRACKING] Failed to sync sibling page ${p.id}: ${err?.message}`);
          }),
        ),
    );
  } catch (err: any) {
    console.error(`[SESSION TRACKING] Failed to list sibling pages for ${page.id}: ${err?.message}`);
  }
}

async function recordFailure(page: GeneratedLandingPage, listId: string | undefined, err: unknown): Promise<void> {
  try {
    await updateLandingPageSessionTracking(page.id, { installed: false, ...(listId ? { listId } : {}), error: (err as Error)?.message || 'session tracking failed' });
  } catch (recordErr: any) {
    console.error(`[SESSION TRACKING] Could not record failure on page ${page.id}: ${recordErr?.message}`);
  }
}

/**
 * Commit exactly one file change to main. Re-reads main right before committing and restarts from a
 * fresh read if it moved, so we never write a layout derived from a stale read over a concurrent edit.
 * (commitFilesToRepoMain itself rebases onto the latest tip on a ref race; that last-millisecond window
 * is the one residual, shared with PUT /update-files.)
 */
async function commitOneFile(
  page: GeneratedLandingPage,
  repoFullName: string,
  headers: Record<string, string>,
  htmlPath: string | undefined,
  compute: (file: RepoFile) => { content: string; message: string } | null,
): Promise<{ file: RepoFile; commitSha?: string }> {
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const sha = await readMainSha(repoFullName, headers);
    const file = await locateTarget(page, repoFullName, headers, sha, htmlPath);
    const next = compute(file);
    if (!next) return { file };
    assertSafePath(file.path);
    if ((await readMainSha(repoFullName, headers)) !== sha) continue; // main moved while we computed: redo from a fresh read
    const { pushedCommitSha } = await commitFilesToRepoMain(
      repoFullName,
      headers,
      [{ path: file.path, content: Buffer.from(next.content, 'utf-8') }],
      next.message,
      4,
      'main',
    );
    return { file, commitSha: pushedCommitSha };
  }
  throw new SessionTrackingError('verify_failed', 'The repository changed repeatedly while editing; try again in a moment.', 409);
}

/**
 * Idempotently enable session tracking for a landing page: (a) create-or-reuse its session list,
 * (b) commit the SDK tag into its own repo, (c) record sessionTrackingListId / Installed on the page.
 * Throws SessionTrackingError for refusals; any failure after the list exists is also recorded on the
 * page (sessionTrackingError) and leaves the list valid for the retry.
 */
export async function enableSessionTrackingForPage(
  page: GeneratedLandingPage,
  opts: EnableSessionTrackingOptions = {},
): Promise<SessionTrackingResult> {
  assertEligible(page);
  const { repoFullName } = parseRepo(page);
  return withRepoLock(repoFullName, async () => {
    const override = !!opts.overrideExistingTracker;
    const origins = await deriveAllowedOrigins(page);
    if (origins.length === 0) {
      throw new SessionTrackingError('no_origins', 'This page has no https address yet, so there is no origin to allow. Deploy it first.', 409);
    }

    const { getGitHubOrgToken } = await import('../utils/secretsManager');
    const { token } = await getGitHubOrgToken();
    const headers = ghHeaders(token);

    // Inspect the repo BEFORE creating anything: a page that must be refused (a tracker of its own, a file
    // shape the injector does not understand) is refused by this dry run, so it never leaves a list behind.
    const probeSha = await readMainSha(repoFullName, headers);
    const probe = await locateTarget(page, repoFullName, headers, probeSha, opts.htmlPath);
    injectFor(probe, 'list_dry_run_probe', override);
    // ...and the REST of the repo, unless our own tag is already there (then this is an idempotent re-run).
    if (!override && extractInstalledListId(probe.content, probe.target) === null) {
      await assertNoTrackerElsewhere(repoFullName, headers, probeSha, probe.path);
    }

    // (a) the list. Repo truth first (what the live tag points at), then the recorded id, else create.
    const installedId = extractInstalledListId(probe.content, probe.target);
    let list = await loadOwnedSessionList(installedId ?? undefined, page.userId);
    if (installedId && !list) {
      throw new SessionTrackingError(
        'list_mismatch',
        `The page's tracking tag points at list ${installedId}, which is not a session list owned by this page's owner. Nothing was changed.`,
        409,
      );
    }
    if (!list) list = await loadOwnedSessionList(page.sessionTrackingListId, page.userId);

    let listCreated = false;
    let allowedOrigins = origins;
    if (list) {
      allowedOrigins = await mergeOrigins(list, origins);
    } else {
      const trackingConfig: TrackingConfig = { allowedOrigins: origins, ...(pageLabelFor(page) ? { pageLabel: pageLabelFor(page) } : {}) };
      const name = `LP Sessions - ${page.name || page.id}`.slice(0, 100);
      const created = await createTrackerSessionList(page.userId, name, trackingConfig);
      listCreated = true;
      // Claim the page for this list; if a concurrent enable (another instance) got there first, use its list.
      const claimed = await claimLandingPageSessionTrackingList(page.id, created.listId, page.sessionTrackingListId);
      if (claimed) {
        list = created;
      } else {
        const winner = await loadOwnedSessionList((await getLandingPageById(page.id))?.sessionTrackingListId, page.userId);
        if (!winner) throw new SessionTrackingError('page_gone', 'The landing page changed while enabling tracking; try again.', 409);
        try {
          await crmDb.deleteLeadList(created.listId); // ours is empty and unreferenced
        } catch (cleanupErr: any) {
          console.warn(`[SESSION TRACKING] Could not delete surplus list ${created.listId}: ${cleanupErr?.message}`);
        }
        listCreated = false;
        list = winner;
        allowedOrigins = await mergeOrigins(winner, origins);
      }
    }
    const listId: string = list.listId;

    // (b) the tag. From here a failure is recorded on the page and the list stays for the retry.
    try {
      const { file, commitSha } = await commitOneFile(page, repoFullName, headers, opts.htmlPath, (f) => {
        if (verifySessionTrackingInjection(f.content, f.target, listId)) return null; // already exactly right: no commit
        return {
          content: injectFor(f, listId, override),
          message: `chore: add AgentWeb session tracking (${listId})`,
        };
      });
      if (commitSha) {
        // Trust but verify: read main back and confirm the tag is really there.
        const after = await readRepoFile(repoFullName, headers, file.path, 'main');
        if (after === null || !verifySessionTrackingInjection(after, file.target, listId)) {
          throw new SessionTrackingError('verify_failed', 'The tracking tag was committed but could not be confirmed on the main branch.', 502);
        }
      }

      // (c) the record. Layout tags are site-wide, so every page of the repo reflects them.
      await updateLandingPageSessionTracking(page.id, { installed: true, listId });
      if (file.target === 'layout') await syncSiblings(page, { installed: true, listId });

      return {
        listId,
        embedSnippet: buildEmbedSnippet(listId),
        installed: true,
        alreadyInstalled: !commitSha,
        listCreated,
        path: file.path,
        ...(commitSha ? { commitUrl: `https://github.com/${repoFullName}/commit/${commitSha}` } : {}),
        allowedOrigins,
      };
    } catch (err) {
      await recordFailure(page, listId, err);
      throw err;
    }
  });
}

/**
 * Remove the SDK tag (the list and its rows are left alone, so history is kept and re-enabling reuses it).
 * Only OUR marked block is touched: a page's own tracker is never removed.
 */
export async function disableSessionTrackingForPage(
  page: GeneratedLandingPage,
  opts: Pick<EnableSessionTrackingOptions, 'htmlPath'> = {},
): Promise<{ removed: boolean; alreadyRemoved: boolean; listId?: string; path?: string; commitUrl?: string }> {
  assertEligible(page);
  const { repoFullName } = parseRepo(page);
  return withRepoLock(repoFullName, async () => {
    const { getGitHubOrgToken } = await import('../utils/secretsManager');
    const { token } = await getGitHubOrgToken();
    const headers = ghHeaders(token);

    const { file, commitSha } = await commitOneFile(page, repoFullName, headers, opts.htmlPath, (f) => {
      if (verifySessionTrackingInjection(f.content, f.target, '')) return null;
      const content = f.target === 'layout' ? injectSessionTrackingIntoLayout(f.content, '') : injectSessionTrackingIntoHtml(f.content, '');
      return { content, message: 'chore: remove AgentWeb session tracking' };
    });
    if (commitSha) {
      const after = await readRepoFile(repoFullName, headers, file.path, 'main');
      if (after === null || !verifySessionTrackingInjection(after, file.target, '')) {
        throw new SessionTrackingError('verify_failed', 'The tracking tag was removed but main could not be confirmed clean.', 502);
      }
    }
    await updateLandingPageSessionTracking(page.id, { installed: false });
    if (file.target === 'layout') await syncSiblings(page, { installed: false });
    return {
      removed: !!commitSha,
      alreadyRemoved: !commitSha,
      ...(page.sessionTrackingListId ? { listId: page.sessionTrackingListId } : {}),
      path: file.path,
      ...(commitSha ? { commitUrl: `https://github.com/${repoFullName}/commit/${commitSha}` } : {}),
    };
  });
}

/**
 * Generation-time hook (flag AUTO_SESSION_TRACKING). NEVER throws: a failure is logged and recorded on
 * the page (enableSessionTrackingForPage does that once the list exists) and generation carries on.
 * A sub-page added to an existing site inherits the site's list with no repo work, because the tag
 * already lives in the shared layout.
 */
export async function autoEnableSessionTracking(
  page: GeneratedLandingPage,
  site?: Pick<GeneratedLandingPage, 'sessionTrackingListId' | 'sessionTrackingInstalled'>,
): Promise<{ listId: string; installed: boolean } | null> {
  if (!isAutoSessionTrackingEnabled()) return null;
  try {
    if (site) {
      if (site.sessionTrackingListId && site.sessionTrackingInstalled) {
        await updateLandingPageSessionTracking(page.id, { installed: true, listId: site.sessionTrackingListId });
        return { listId: site.sessionTrackingListId, installed: true };
      }
      return null; // the site was never tracked: a new sub-page must not silently start tracking it
    }
    const r = await enableSessionTrackingForPage(page);
    return { listId: r.listId, installed: r.installed };
  } catch (err: any) {
    console.error(`[SESSION TRACKING] Auto-enable failed for page ${page.id} (generation continues): ${err?.message}`);
    // Refusals thrown before the list exists have nothing recorded yet; record them too.
    await recordFailure(page, undefined, err);
    return null;
  }
}
