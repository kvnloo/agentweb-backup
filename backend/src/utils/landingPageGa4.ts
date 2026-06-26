/**
 * Pure resolver for mapping a landing-page hostname to the correct GA4
 * property + measurement ID.
 *
 * Background: landing pages deploy onto managed subdomains. Historically the
 * platform stored a SINGLE domain→GA4 mapping (agentwebforms.com → one GA4
 * property) in Secrets Manager. Audit pages live on a *different* root domain
 * (agentweb.pro), so the single-mapping `.endsWith('.agentwebforms.com')`
 * checks never matched them — they emitted no GA4 data and showed nothing in
 * the funnel report (the "subdomain GA4 missing" gap).
 *
 * The config now carries a base mapping plus `additionalDomains[]`, and this
 * resolver picks the most specific matching mapping for a given host. Kept as a
 * standalone pure function so it can be unit-tested without Secrets Manager or
 * any AWS mocking, and reused by every call site that needs to resolve GA4 for
 * a landing-page host (deploy-time auto-config + metrics display).
 */

import { LandingPagesConfig } from './secretsManager';

export interface LandingPageDomainMapping {
  /** Root domain the mapping applies to (e.g. "agentweb.pro"). */
  gscDomain: string;
  /** GA4 numeric property ID used for metrics queries. */
  ga4PropertyId: string;
  /** GA4 measurement ID (G-XXXX) baked into the page's gtag, if any. */
  ga4MeasurementId?: string;
}

/**
 * Normalize a host: lowercase and strip any trailing port (":443").
 * Returns "" for nullish/blank input.
 */
function normalizeHost(host: string | undefined | null): string {
  if (!host) return '';
  return host.trim().toLowerCase().split(':')[0];
}

/**
 * True when `host` equals `domain` or is a subdomain of it. Guards against
 * suffix-substring false positives ("notagentweb.pro" must not match
 * "agentweb.pro").
 */
function hostMatchesDomain(host: string, domain: string): boolean {
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Resolve the GA4 mapping for a landing-page host.
 *
 * Considers the base mapping (gscDomain/ga4PropertyId/ga4MeasurementId) and
 * every entry in `additionalDomains`. When more than one mapping matches
 * (e.g. "agentweb.pro" and "audit.agentweb.pro" both match
 * "page.audit.agentweb.pro"), the most specific — longest gscDomain — wins.
 *
 * Returns null when the config is absent or no mapping matches.
 */
export function resolveLandingPageGa4(
  config: LandingPagesConfig | null | undefined,
  host: string | undefined | null,
): LandingPageDomainMapping | null {
  if (!config) return null;
  const normalized = normalizeHost(host);
  if (!normalized) return null;

  const candidates: LandingPageDomainMapping[] = [];

  // Base mapping (getLandingPagesConfig already guarantees these two fields).
  if (config.gscDomain && config.ga4PropertyId) {
    candidates.push({
      gscDomain: config.gscDomain,
      ga4PropertyId: config.ga4PropertyId,
      ga4MeasurementId: config.ga4MeasurementId,
    });
  }

  for (const extra of config.additionalDomains ?? []) {
    // Skip malformed entries so one bad mapping can't break resolution.
    if (extra?.gscDomain && extra?.ga4PropertyId) {
      candidates.push({
        gscDomain: extra.gscDomain,
        ga4PropertyId: extra.ga4PropertyId,
        ga4MeasurementId: extra.ga4MeasurementId,
      });
    }
  }

  const matches = candidates.filter((c) =>
    hostMatchesDomain(normalized, c.gscDomain.toLowerCase()),
  );
  if (matches.length === 0) return null;

  // Most specific mapping wins: longest gscDomain.
  matches.sort((a, b) => b.gscDomain.length - a.gscDomain.length);
  return matches[0];
}
