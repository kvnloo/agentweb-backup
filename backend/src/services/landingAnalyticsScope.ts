/**
 * Keeps each customer's view of the PLATFORM's own landing-page analytics to the customer's own landing pages.
 *
 * Customers' landing pages deploy onto managed `*.agentwebforms.com` subdomains (MANAGED_LANDING_BASE). Their traffic is tracked in the
 * platform's own GA4 property and Search Console domain property for that base (`getLandingPagesConfig`), and deploying a page adds them to
 * the deployer's analytics config so their traffic shows up. Those hold EVERY customer's landing-page traffic, so any read of them through
 * the shared service account must be limited to the caller's own pages. Only the mappings for the managed base (and its subdomains) are
 * scoped: other entries of the config (the audit pages on agentweb.pro, AgentWeb's own domain) hold AgentWeb's own pages, which customers
 * cannot deploy to, and scoping them would cut AgentWeb's own site analytics:
 *  - GA4: `scopeGaClient` wraps the Data API client; a report on a platform property gets an extra dimension filter (AND) that keeps only
 *    the caller's own locations (a host, or a host and a path prefix);
 *  - Search Console: `gscScopeFilter` gives the extra `page` filter (includingRegex) for a platform domain property;
 *  - `hasLocationOn` gates the platform property the metrics route adds for a host named in `?domain=`.
 * A caller with no own location gets an impossible filter (an empty answer of the usual shape), never the unfiltered property.
 *
 * Own locations = the domains the caller (and the members of the caller's organization: one tenant) own in AW-CustomDomains (managed
 * subdomains and custom domains: the whole host), plus each own non-archived landing page's live URL (customDomainUrl, else deployedUrl):
 * its host when that host is owned, or is a project's own `*.vercel.app` host; otherwise, on a platform domain, only its host AND path
 * prefix (a shared platform host is never claimed whole). A read failure of these lists fails closed (no own location). Cached 5 minutes
 * per caller (a failed read is not cached). The platform ids are cached 10 minutes; the managed base's Search Console domain is always
 * recognised, but its GA4 property id comes only from the config: when the config has never loaded (getLandingPagesConfig answers null
 * rather than throwing) that property cannot be recognised and an error is logged on every attempt (one a minute) so the gap is visible.
 * GA4 ids are compared without a `properties/` prefix or leading zeros.
 */
import { BetaAnalyticsDataClient } from "@google-analytics/data";

export interface OwnLocation {
  host: string;
  /** Path prefix ("/acme-audit"), only when the host itself is not the caller's. */
  path?: string;
}

const PLATFORM_TTL_MS = 10 * 60_000;
/** While the platform ids have never loaded, try again after a minute rather than ten. */
const PLATFORM_RETRY_MS = 60_000;
const LOCATIONS_TTL_MS = 5 * 60_000;
const LOCATIONS_CACHE_MAX = 2000;
/** More locations than this are cut (the caller sees fewer of their own pages; never another customer's). */
export const MAX_LOCATIONS = 100;
const NO_LOCATION_HOST = "no-own-landing-page.invalid";
/** The managed landing-page base (customDomainService SUBDOMAIN_BASE; a test keeps the two equal). */
export const MANAGED_LANDING_BASE = "agentwebforms.com";

const platform: { ga4: Set<string>; gsc: Set<string>; at: number; loading: Promise<void> | null } = {
  ga4: new Set(),
  gsc: new Set([MANAGED_LANDING_BASE]),
  at: 0,
  loading: null,
};
let platformKnown = false;
const locationsCache = new Map<string, { at: number; locations: OwnLocation[] }>();

/** Tests only. */
export function resetLandingAnalyticsScopeForTest(): void {
  platform.ga4 = new Set();
  platform.gsc = new Set([MANAGED_LANDING_BASE]);
  platform.at = 0;
  platform.loading = null;
  platformKnown = false;
  locationsCache.clear();
}

export function bareDomain(value: string): string {
  return String(value ?? "").trim().toLowerCase().replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").split(":")[0];
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return !!host && !!domain && (host === domain || host.endsWith(`.${domain}`));
}

/** A GA4 property id as GA4 resolves it: no `properties/` prefix, no padding, no leading zeros ("0999" and "999" are one property). */
export function normaliseGa4PropertyId(value: unknown): string {
  return String(value ?? "").trim().replace(/^properties\//, "").trim().replace(/^0+(?=\d)/, "");
}

async function loadPlatformIds(): Promise<void> {
  if (platform.loading) return platform.loading;
  if (platform.at !== 0 && Date.now() - platform.at < (platformKnown ? PLATFORM_TTL_MS : PLATFORM_RETRY_MS)) return;
  platform.loading = (async () => {
    try {
      const { getLandingPagesConfig } = await import("../utils/secretsManager");
      const config: any = await getLandingPagesConfig();
      const ga4 = new Set<string>();
      const gsc = new Set<string>([MANAGED_LANDING_BASE]);
      if (config && typeof config === "object") {
        for (const m of [config, ...(Array.isArray(config.additionalDomains) ? config.additionalDomains : [])]) {
          const domain = typeof m?.gscDomain === "string" ? bareDomain(m.gscDomain) : "";
          // Only the mappings for customer landing pages (the managed base and its subdomains); see the header.
          if (!hostMatchesDomain(domain, MANAGED_LANDING_BASE)) continue;
          gsc.add(domain);
          const id = normaliseGa4PropertyId(m?.ga4PropertyId);
          if (/^\d+$/.test(id)) ga4.add(id);
        }
      }
      if (ga4.size === 0) {
        if (!platformKnown) {
          console.error("[landingAnalyticsScope] the platform landing-page GA4 property could not be loaded (LandingPages config); reads of it are not limited to the caller's own pages until it loads");
        }
        return;
      }
      platform.ga4 = ga4;
      platform.gsc = gsc;
      platformKnown = true;
    } catch (err: any) {
      if (!platformKnown) console.error("[landingAnalyticsScope] could not load the platform landing-page ids:", err?.message || err);
    } finally {
      platform.at = Date.now();
      platform.loading = null;
    }
  })();
  return platform.loading;
}

function hostOf(url: unknown): { host: string; path: string } | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { host: u.hostname.toLowerCase(), path: u.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

async function loadOwnLocations(userId: string, orgId: string | undefined): Promise<OwnLocation[]> {
  const cacheKey = `${userId}|${orgId ?? ""}`;
  const cached = locationsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LOCATIONS_TTL_MS) return cached.locations;
  let locations: OwnLocation[] = [];
  try {
    const { orgDb } = await import("./db");
    const { listDomains } = await import("./customDomainService");
    const { getLandingPagesByOwner } = await import("./v0Service");
    const owners = new Set<string>([userId]);
    if (orgId) {
      for (const m of (await orgDb.getOrgMembers(orgId)) || []) if (m?.userId) owners.add(m.userId);
    }
    const ownerIds = [...owners];
    const [domainLists, pageLists] = await Promise.all([
      Promise.all(ownerIds.map((id) => listDomains(id))),
      Promise.all(ownerIds.map((id) => getLandingPagesByOwner(id))),
    ]);
    const hosts = new Set<string>();
    for (const d of domainLists.flat()) {
      const host = bareDomain((d as any)?.domain ?? "");
      if (host) hosts.add(host);
    }
    await loadPlatformIds();
    const paths = new Map<string, OwnLocation>();
    for (const page of pageLists.flat() as any[]) {
      for (const url of [page?.customDomainUrl, page?.deployedUrl]) {
        const at = hostOf(url);
        if (!at || hosts.has(at.host)) continue;
        if (at.host.endsWith(".vercel.app")) {
          hosts.add(at.host);
          continue;
        }
        const onPlatform = [...platform.gsc].some((domain) => hostMatchesDomain(at.host, domain));
        if (onPlatform && at.path && at.path !== "/") paths.set(`${at.host}${at.path}`, { host: at.host, path: at.path });
      }
    }
    locations = [...[...hosts].map((host) => ({ host })), ...[...paths.values()].filter((p) => !hosts.has(p.host))].slice(0, MAX_LOCATIONS);
  } catch (err: any) {
    // Fail closed for this read, and do not remember the failure (one throttled read must not blank the next five minutes).
    console.error("[landingAnalyticsScope] could not read the caller's landing pages; platform analytics read as empty:", err?.message || err);
    return [];
  }
  if (locationsCache.size >= LOCATIONS_CACHE_MAX) locationsCache.clear();
  locationsCache.set(cacheKey, { at: Date.now(), locations });
  return locations;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface LandingAnalyticsScope {
  isPlatformGa4(propertyId: string): Promise<boolean>;
  isPlatformGscSite(siteUrl: string): Promise<boolean>;
  /** True when the caller owns the host or a page path on it. */
  hasLocationOn(host: string): Promise<boolean>;
  locations(): Promise<OwnLocation[]>;
}

/** `user` is the stored user record (untyped DynamoDB item): only `userId` and `orgId` are read. */
export function createLandingAnalyticsScope(user: { userId?: unknown; orgId?: unknown } | Record<string, any>): LandingAnalyticsScope {
  const userId = typeof user?.userId === "string" ? user.userId : "";
  const orgId = typeof user?.orgId === "string" && user.orgId ? user.orgId : undefined;
  let memo: Promise<OwnLocation[]> | null = null;
  // No user id: no own location (fail closed).
  const locations = () => (memo ??= userId ? loadOwnLocations(userId, orgId) : Promise.resolve([]));
  return {
    async isPlatformGa4(propertyId) {
      await loadPlatformIds();
      return platform.ga4.has(normaliseGa4PropertyId(propertyId));
    },
    async isPlatformGscSite(siteUrl) {
      // A property for a subdomain of a platform domain is the platform's too (its verification can come from the domain property).
      await loadPlatformIds();
      const host = bareDomain(siteUrl);
      return [...platform.gsc].some((domain) => hostMatchesDomain(host, domain));
    },
    async hasLocationOn(host) {
      const h = bareDomain(host);
      return (await locations()).some((l) => l.host === h);
    },
    locations,
  };
}

/** The GA4 dimension filter that keeps only the caller's own locations. */
export function ga4LocationsFilter(locations: OwnLocation[]): any {
  const wholeHosts = locations.filter((l) => !l.path).map((l) => l.host);
  const parts: any[] = [];
  if (wholeHosts.length > 0) parts.push({ filter: { fieldName: "hostName", inListFilter: { values: wholeHosts, caseSensitive: false } } });
  for (const l of locations.filter((loc) => loc.path)) {
    // The page itself or a path under it: "/acme" must not match "/acme-2".
    parts.push({
      andGroup: {
        expressions: [
          { filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: l.host, caseSensitive: false } } },
          {
            orGroup: {
              expressions: [
                { filter: { fieldName: "pagePath", stringFilter: { matchType: "EXACT", value: l.path, caseSensitive: false } } },
                { filter: { fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: `${l.path}/`, caseSensitive: false } } },
              ],
            },
          },
        ],
      },
    });
  }
  if (parts.length === 0) return { filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: NO_LOCATION_HOST } } };
  return parts.length === 1 ? parts[0] : { orGroup: { expressions: parts } };
}

/** `existing AND scope`, keeping an existing andGroup flat. */
export function andFilters(existing: any, scope: any): any {
  if (!existing) return scope;
  if (existing.andGroup?.expressions) return { andGroup: { expressions: [...existing.andGroup.expressions, scope] } };
  return { andGroup: { expressions: [existing, scope] } };
}

/** The Search Console `page` filter that keeps only the caller's own locations. */
export function gscLocationsFilter(locations: OwnLocation[]): { dimension: "page"; operator: "includingRegex"; expression: string } {
  const alternatives = locations.map((l) => (l.path ? `${escapeRegex(l.host)}${escapeRegex(l.path)}` : escapeRegex(l.host)));
  const body = alternatives.length > 0 ? alternatives.join("|") : escapeRegex(NO_LOCATION_HOST);
  return { dimension: "page", operator: "includingRegex", expression: `^https?://(${body})([/?#]|$)` };
}

/** The extra Search Console filter for a site: null unless the site is a platform domain property. */
export async function gscScopeFilter(scope: LandingAnalyticsScope, siteUrl: string): Promise<ReturnType<typeof gscLocationsFilter> | null> {
  if (!(await scope.isPlatformGscSite(siteUrl))) return null;
  return gscLocationsFilter(await scope.locations());
}

/**
 * The GA4 Data API client, with every runReport on a platform property limited to the caller's own locations. Other properties and other
 * methods are untouched.
 */
export function scopeGaClient<T extends Pick<BetaAnalyticsDataClient, "runReport"> | null>(client: T, scope: LandingAnalyticsScope): T {
  if (!client) return client;
  const runReport = client.runReport.bind(client) as (...args: any[]) => any;
  return new Proxy(client as object, {
    get(target, prop, receiver) {
      if (prop !== "runReport") return Reflect.get(target, prop, receiver);
      return async (request: any, ...rest: any[]) => {
        if (request && (await scope.isPlatformGa4(request.property))) {
          request = { ...request, dimensionFilter: andFilters(request.dimensionFilter, ga4LocationsFilter(await scope.locations())) };
        }
        return runReport(request, ...rest);
      };
    },
  }) as T;
}
