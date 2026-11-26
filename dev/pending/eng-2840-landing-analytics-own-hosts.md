## ENG-2840: Platform landing-page analytics are read only for the caller's own pages (2026-11-26)

- The problem (pre-existing, found while auditing the shared Google service account): landing pages deploy onto platform domains, and
  their traffic is tracked in the platform's OWN GA4 properties and Search Console domain properties (`getLandingPagesConfig`: the
  `agentwebforms.com` mapping and `additionalDomains`). Two ways let a customer read other customers' landing-page traffic through the shared
  service account: `GET /api/seo/metrics?domain=<any managed landing host>` added the platform property and filtered GA4 (and, through the
  "parent domain" fallback, Search Console) to the host NAMED in the request, with no check that the host was the caller's; and deploying a
  landing page adds the platform property and root domain to the deployer's analytics config (`v0Service.ts`, auto-configure), so the
  deployer's unfiltered analytics (the portal's Analytics & SEO page, Emma's `get_website_analytics` / `get_seo_metrics`, the product and
  funnel reports) included every customer's landing-page sessions, pages, sources and search queries, minus only their own `gaFilteredDomains`.
- The fix (`services/landingAnalyticsScope.ts`): every read of a platform property or domain keeps only the caller's own locations.
  GA4: `scopeGaClient` wraps the Data API client at every place one is created for a customer read (`/metrics` and its funnel,
  `/product-metrics`, `fetchGoogleAnalyticsMetrics`); a `runReport` on a platform property gets the own-locations dimension filter ANDed to
  its own. Search Console: `gscScopeFilter` adds a `page` `includingRegex` filter for a platform domain property or any subdomain property of
  it (`/metrics`, `/debug`, `fetchSearchConsoleMetrics`). `?domain=` adds the platform property only for a host where the caller has a page.
  A caller with no own location gets an impossible filter (an empty answer of the usual shape), never the whole property. Customer-owned
  properties and domains are untouched.
- Own locations: the domains the caller and the members of the caller's organization own in AW-CustomDomains (managed subdomains and
  custom domains: whole host), plus each own non-archived landing page's URL: a project's own `*.vercel.app` host whole; on a platform
  domain host not owned in AW-CustomDomains, only that host AND the page path (`/acme` and below, never `/acme-2`); the root of such a
  host is never claimed. A read failure of these lists fails closed (no location). Cached 5 minutes per caller; at most 100 locations.
  Platform ids are cached 10 minutes; if they have never loaded (Secrets Manager down at start), platform properties cannot be recognised
  and reads behave as before until a retry (every minute) works.
- What a customer sees change: only their own landing pages' traffic on the platform property (before: every customer's). Their own
  GA4 properties and Search Console domains are read exactly as before. GA4 key-event configuration of a platform property (event names,
  no traffic) is not filtered. Not changed: the GA4 probe `POST /api/seo/config/ga/test` (it reports only whether the service account can
  open a property).
- Proof: `landingAnalyticsScope.test.ts` (filters, regex boundaries, own-location rules, org members, fail-closed, caching, the client
  wrapper), `seoRoutes.landingScope.test.ts` (a deployer, `?domain=` another customer's host, the caller's own host, product metrics) and
  `seoService.landingScope.test.ts` (Emma's readers). Removing the GA wrapper or the Search Console filter from `/metrics` fails the route
  tests.
