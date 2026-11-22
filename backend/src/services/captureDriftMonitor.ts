/**
 * ENG-3120 (ENG-1289.1): run the capture-drift detector over every generated landing-page
 * repo that carries an attribution pixel, and raise ONE deduped oncall alert per drifted
 * site.
 *
 * `detectCaptureDrift` (captureDriftDetector.ts) shipped pure and had no production caller,
 * so a site whose injected middleware.ts / capture route went stale stayed invisible until
 * the "0 of N leads carry a click ID" blackout fired downstream. This wires it into the
 * daily metaTrackingMonitorCron run.
 *
 * READ-ONLY by construction: the only repo operation reachable from here is a GitHub
 * contents GET. Nothing re-injects, commits, or calls an ad account. Re-injection stays a
 * deliberate human/agent action (syncLeadCaptureFilesToRepo), never a side effect of a
 * monitor.
 */
import { detectCaptureDrift, type CaptureDriftReport } from './captureDriftDetector';
import type { AlertTransport } from './metaTrackingMonitor';

const TAG = '[captureDriftMonitor]';

export const CAPTURE_DRIFT_ALERT_CLASS = 'lp-capture-drift';
export const MIDDLEWARE_PATH = 'middleware.ts';
export const CAPTURE_ROUTE_PATH = 'app/api/capture/route.ts';

/** Same rate-limit shape as the meta-* classes: at most once per site per window. */
export const CAPTURE_DRIFT_REALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CaptureDriftSite {
  repoFullName: string;
  name: string;
  userId?: string;
  email?: string;
}

export interface CaptureDriftDeps {
  /** Every generated site with an attribution pixel, one entry per repo. */
  listSites: () => Promise<CaptureDriftSite[]>;
  /** File on the repo's `main`, or null when absent. Throws on any other failure. */
  readFile: (repoFullName: string, path: string) => Promise<string | null>;
  transport?: AlertTransport;
  dryRun?: boolean;
  now?: number;
}

export interface CaptureDriftSummary {
  sitesChecked: number;
  drifted: number;
  clean: number;
  unreadable: number;
  alertsSent: number;
  findings: Array<{ repoFullName: string; name: string; report: CaptureDriftReport }>;
}

const lastAlertAtByKey = new Map<string, number>();

export function __resetCaptureDriftAlertStateForTests(): void {
  lastAlertAtByKey.clear();
}

function shouldSuppress(key: string, now: number): boolean {
  const last = lastAlertAtByKey.get(key);
  if (last !== undefined && now - last < CAPTURE_DRIFT_REALERT_WINDOW_MS) return true;
  lastAlertAtByKey.set(key, now);
  return false;
}

const defaultTransport: AlertTransport = async (subject, message, context) => {
  const { emailService } = await import('./emailService');
  await emailService.sendOncallAlert(subject, message, context);
};

export async function runCaptureDriftSweep(deps: CaptureDriftDeps): Promise<CaptureDriftSummary> {
  const now = deps.now ?? Date.now();
  const dryRun = deps.dryRun === true;
  const transport = deps.transport ?? defaultTransport;
  const summary: CaptureDriftSummary = {
    sitesChecked: 0, drifted: 0, clean: 0, unreadable: 0, alertsSent: 0, findings: [],
  };

  let sites: CaptureDriftSite[];
  try {
    sites = (await deps.listSites()) ?? [];
  } catch (error: any) {
    console.error(`${TAG} site list failed: ${error?.message}`);
    return summary;
  }

  const seen = new Set<string>();
  for (const site of sites) {
    if (!site?.repoFullName || seen.has(site.repoFullName)) continue;
    seen.add(site.repoFullName);
    summary.sitesChecked++;

    let report: CaptureDriftReport;
    try {
      const [middleware, captureRoute] = await Promise.all([
        deps.readFile(site.repoFullName, MIDDLEWARE_PATH),
        deps.readFile(site.repoFullName, CAPTURE_ROUTE_PATH),
      ]);
      report = detectCaptureDrift({ middleware, captureRoute });
    } catch (error: any) {
      summary.unreadable++;
      console.warn(`${TAG} ${site.repoFullName}: unreadable, skipped — ${error?.message}`);
      continue;
    }

    if (!report.drifted) {
      summary.clean++;
      continue;
    }
    summary.drifted++;
    summary.findings.push({ repoFullName: site.repoFullName, name: site.name, report });

    const bad = report.files.filter((f) => f.status !== 'match');
    const key = `${CAPTURE_DRIFT_ALERT_CLASS}:${site.repoFullName}`;
    // Dry run neither reads nor writes suppression, same contract as metaTrackingMonitor.raise.
    if (!dryRun && shouldSuppress(key, now)) continue;

    const lines = [
      `Site "${site.name}" (${site.repoFullName}) has platform-owned capture files that differ from the current generator output.`,
      'Leads from this site may lose click IDs / attribution. Read-only finding; nothing was changed.',
      '',
      ...bad.map((f) =>
        f.status === 'missing'
          ? `- ${f.path}: missing`
          : `- ${f.path}: drifted at line ${f.firstDiffLine}\n    expected: ${f.expectedLine}\n    actual:   ${f.actualLine}`,
      ),
    ];
    try {
      await transport(
        `Landing page capture files drifted: ${site.name}`,
        lines.join('\n'),
        {
          'Alert Class': CAPTURE_DRIFT_ALERT_CLASS,
          // ENG-3143: intake dedupes on Alert Class unless Alert Scope narrows it (ENG-2267).
          // Without a per-repo scope every drifted site folded into the first site's issue.
          'Alert Scope': captureDriftAlertScope(site.repoFullName),
          'Alert Priority': 'low',
          Repo: site.repoFullName,
          'Owner User Id': site.userId,
          'Owner Email': site.email,
          'Drifted Files': bad.map((f) => f.path).join(', '),
        },
      );
      summary.alertsSent++;
    } catch (error: any) {
      console.error(`${TAG} alert send failed for ${site.repoFullName}: ${error?.message}`);
    }
  }

  console.log(
    `${TAG} ${dryRun ? '[DRY RUN] ' : ''}checked ${summary.sitesChecked} site(s): ${summary.clean} clean, ` +
      `${summary.drifted} drifted, ${summary.unreadable} unreadable, ${summary.alertsSent} alert(s)`,
  );
  return summary;
}

/** Per-site intake dedupe scope (ENG-3143): one oncall item per landing-page repo. */
export function captureDriftAlertScope(repoFullName: string): string {
  return `lp-repo:${repoFullName.toLowerCase()}`;
}

/** Repo full name from a page's githubRepoUrl, or null. */
export function repoFullNameFromUrl(url?: string | null): string | null {
  const m = String(url ?? '').match(/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#]|$)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Production site list: every non-archived page with a repo and a Meta pixel, per user. */
export function sitesFromPages(
  pages: Array<{ name?: string; githubRepoUrl?: string; metaPixelId?: string; archived?: boolean; userId?: string }>,
  owner?: { userId?: string; email?: string },
): CaptureDriftSite[] {
  const out: CaptureDriftSite[] = [];
  for (const p of pages ?? []) {
    if (p?.archived || !p?.metaPixelId) continue;
    const repo = repoFullNameFromUrl(p.githubRepoUrl);
    if (!repo) continue;
    out.push({ repoFullName: repo, name: p.name || repo, userId: owner?.userId ?? p.userId, email: owner?.email });
  }
  return out;
}

/** Production GitHub reader: contents GET on `main` only. 404 -> null; anything else throws. */
export async function defaultReadRepoFile(repoFullName: string, path: string): Promise<string | null> {
  const axios = (await import('axios')).default;
  const { getGitHubOrgToken } = await import('../utils/secretsManager');
  const { token } = await getGitHubOrgToken();
  try {
    const res = await axios.get<any>(
      `https://api.github.com/repos/${repoFullName}/contents/${path}?ref=main`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, timeout: 15000 },
    );
    if (!res.data || typeof res.data.content !== 'string') return null;
    return Buffer.from(res.data.content, 'base64').toString('utf-8');
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}
