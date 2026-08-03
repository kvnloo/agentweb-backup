/**
 * ENG-736: Truthful reporting for landing-page deployments.
 *
 * Symptom (2 prod sessions, 24h window): the agent finished a landing-page
 * build — a get_deployment_status / generate_landing_page tool returned
 * status=deployed + buildStatus=success + a live deployedUrl IN-SESSION — yet
 * its FINAL message told the user "the deployment step timed out" and withheld
 * the URL, so the user believed the whole thing had failed.
 *
 * The model fixated on an EARLIER transient timeout (the first v0 attempt can
 * return status="failed" with V0_CALL_TIMEOUT while the build finishes detached)
 * and never reconciled it against the later success it had already observed.
 *
 * This is a pure, deterministic guard (no LLM, no feature flag): whenever a
 * landing-deployment tool returned a genuinely successful, live URL this run and
 * the final message does NOT already contain that URL, surface it. It only ever
 * ADDS the true deliverable — it never removes or rewrites the model's own text —
 * so it cannot fabricate a false success (an actual failure produces no URL to
 * surface). The caller applies it at the loop edge, exactly like the finalize
 * guard, so both the live reply and the persisted transcript carry the URL.
 */

/** A landing-page tool-ledger entry (agentMode toolCalls[]): { name, result, error }. */
export interface LandingLedgerEntry {
  name?: string;
  result?: any;
  error?: any;
}

export interface DeployedLandingUrl {
  url: string;
  /** Page display name, when the tool result carried one. */
  name?: string;
}

/**
 * Landing-page tools whose SUCCESSFUL result exposes a public/live URL. Read-only
 * lookups (list_landing_pages, get_landing_page) are intentionally excluded — this
 * guard is about a deployment that happened THIS run, not surfacing arbitrary
 * URLs the model chose not to mention.
 */
const LANDING_DEPLOYMENT_TOOLS = new Set<string>([
  'generate_landing_page',
  'deploy_landing_page',
  'duplicate_landing_page',
  'get_deployment_status',
  'get_landing_page_preview_url',
]);

function firstHttpUrl(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\/\S+$/i.test(c.trim())) return c.trim();
  }
  return undefined;
}

/** Extract a live URL from one ledger entry, or null when it is not a success. */
function successfulUrlFromEntry(entry: LandingLedgerEntry | null | undefined): DeployedLandingUrl | null {
  if (!entry || entry.error !== undefined) return null;
  const name = entry.name;
  if (!name || !LANDING_DEPLOYMENT_TOOLS.has(name)) return null;
  const r = entry.result;
  if (!r || typeof r !== 'object') return null;

  // Record-shaped tools (generate/deploy/duplicate) return the page record: only a
  // status of "deployed" means it actually went live ("failed" / "generating" /
  // "deploying" do not).
  if (name === 'generate_landing_page' || name === 'deploy_landing_page' || name === 'duplicate_landing_page') {
    if (r.status !== 'deployed') return null;
    const url = firstHttpUrl(r.customDomainUrl, r.deployedUrl);
    if (!url) return null;
    return { url, name: typeof r.name === 'string' ? r.name : undefined };
  }

  // Status/preview tools gate on buildStatus === "success" (other values: error,
  // timeout, building, route_not_live, not_found, no_deployment — none are live).
  if (name === 'get_deployment_status') {
    if (r.buildStatus !== 'success') return null;
    const url = firstHttpUrl(r.customDomainUrl, r.deployedUrl);
    if (!url) return null;
    return { url, name: typeof r.name === 'string' ? r.name : undefined };
  }
  if (name === 'get_landing_page_preview_url') {
    if (r.buildStatus !== 'success') return null;
    const url = firstHttpUrl(r.previewUrl);
    if (!url) return null;
    return { url, name: undefined };
  }
  return null;
}

/** URLs of landing pages that genuinely deployed live this run, de-duplicated by URL. */
export function collectSuccessfulLandingUrls(toolCalls: LandingLedgerEntry[] | null | undefined): DeployedLandingUrl[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: DeployedLandingUrl[] = [];
  const seen = new Set<string>();
  for (const entry of toolCalls) {
    const hit = successfulUrlFromEntry(entry);
    if (!hit) continue;
    const key = hit.url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** True when the final text already mentions this URL (raw or protocol-stripped). */
function contentMentionsUrl(content: string, url: string): boolean {
  const haystack = content.toLowerCase();
  const normalized = url.toLowerCase().replace(/\/+$/, '');
  if (haystack.includes(normalized)) return true;
  const noProtocol = normalized.replace(/^https?:\/\//, '');
  return noProtocol.length > 0 && haystack.includes(noProtocol);
}

/**
 * Surface any successfully-deployed landing-page URL the final message omits.
 * Returns `content` unchanged when there is nothing to add (no successful deploy,
 * the URL is already present, or the model produced no final text to augment).
 */
export function reconcileLandingDeploymentReport(
  content: string,
  toolCalls: LandingLedgerEntry[] | null | undefined,
): string {
  if (typeof content !== 'string' || content.trim().length === 0) return content;
  const deployed = collectSuccessfulLandingUrls(toolCalls);
  if (deployed.length === 0) return content;

  const missing = deployed.filter((d) => !contentMentionsUrl(content, d.url));
  if (missing.length === 0) return content;

  const lines = missing.map((d) =>
    d.name
      ? `🔗 Your landing page **${d.name}** was deployed successfully — preview it here: ${d.url}`
      : `🔗 Your landing page was deployed successfully — preview it here: ${d.url}`,
  );
  return `${content.replace(/\s+$/, '')}\n\n${lines.join('\n')}`;
}
