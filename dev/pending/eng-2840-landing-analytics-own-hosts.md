## ENG-2840: Platform landing-page analytics are read only for the caller's own pages (2026-11-26)

- The problem (pre-existing, found while auditing the shared Google service account): landing pages deploy onto platform domains, and
  their traffic is tracked in the platform's OWN GA4 properties and Search Console domain properties (`getLandingPagesConfig`: the
  `agentwebforms.com` mapping and `additionalDomains`). Two ways let a customer read other customers' landing-page traffic through the shared
  service account: `GET /api/seo/metrics?domain=<any managed landing host>` added the platform property and filtered GA4 (and, through the
  "parent domain" fallback, Search Console) to the host NAMED in the request, with no check that the host was the caller's; and deploying a
  landing page adds the platform property and root domain to the deployer's analytics config (`v0Service.ts`, auto-configure), so the
  deployer's unfiltered analytics (the portal's Analytics & SEO page, Emma's `get_website_analytics` / `get_seo_metrics`, the product and
  funnel reports) included every customer's landing-page sessions, pages, sources and search queries, minus only their own `gaFilteredDomains`.
- The fix (`services/landingAnalyticsScope.ts`): every read of the managed base's platform property or domain keeps only the caller's own
  locations. Only the config mappings for the managed base (`agentwebforms.com`, customDomainService `SUBDOMAIN_BASE`, and its
  subdomains) are scoped: the other entry (audit pages on `agentweb.pro`, AgentWeb's own domain, where customers cannot deploy) holds
  AgentWeb's own pages, and scoping it would cut AgentWeb's own site analytics (the founders' SEO page, Emma for them, the admin business
  funnel's `agentweb.pro` read). A customer who saves `agentweb.pro` or its property in their own config is the broader "any property the
  service account can open" gap, handled by the shared-account audit and its enforcement step.
  GA4: `scopeGaClient` wraps the Data API client at every place one is created for a customer read (`/metrics` and its funnel,
  `/product-metrics`, `fetchGoogleAnalyticsMetrics`); a `runReport` on a platform property gets the own-locations dimension filter ANDed to
  its own. Search Console: `gscScopeFilter` adds a `page` `includingRegex` filter for a platform domain property or any subdomain property of
  it (`/metrics`, `/debug`, `fetchSearchConsoleMetrics`). `?domain=` adds the platform property only for a host where the caller has a page.
  A caller with no own location gets an impossible filter (an empty answer of the usual shape), never the whole property. Customer-owned
  properties and domains are untouched.
- Own locations: the ACTIVE domains the caller and the members of the caller's organization own in AW-CustomDomains (managed subdomains
  and verified custom domains: whole host; a pending custom-domain row can be written for any host nobody has attached yet, even one of
  AgentWeb's own, so it is not ownership), plus each own non-archived landing page's URL: a project's own `*.vercel.app` host whole; on a platform
  domain host not owned in AW-CustomDomains, only that host AND the page path (`/acme` and below, never `/acme-2`); the root of such a
  host is never claimed. A read failure of these lists fails closed (no location) and is not cached. Cached 5 minutes per caller; at most
  100 locations. GA4 ids are compared without `properties/`, padding or leading zeros (a padded id saved in a config is the same property).
  Platform ids are cached 10 minutes; the managed base's Search Console domain is always recognised, but its GA4 property id comes only
  from the config: if the config has never loaded, that property cannot be recognised (reads of it behave as before) and
  `[landingAnalyticsScope] the platform landing-page GA4 property could not be loaded` is logged on every attempt (one a minute).
- What a customer sees change: only their own landing pages' traffic on the platform property (before: every customer's). Their own
  GA4 properties and Search Console domains are read exactly as before. GA4 key-event configuration of a platform property (event names,
  no traffic) is not filtered. Not changed: the GA4 probe `POST /api/seo/config/ga/test` (it reports only whether the service account can
  open a property).
- Changed for AgentWeb's own accounts: `?domain=audit.agentweb.pro` (or another host of the unscoped `agentweb.pro` mapping) no longer adds
  the audit property unless the account owns that host (a domain row or a page path there); the founders' normal reads of their own
  config are unchanged.
- Residual risks, known: a managed subdomain released by one customer and later taken by another gives the new owner the old owner's
  history for that host (ownership has no start date); a page on a managed host with no domain row ("rowless" pages) gets no root-page
  traffic, since the root of a host the caller does not own is never claimed; more than 100 own locations are cut (fewer of the caller's
  own pages, never another's). A new GA4 or Search Console read of customer analytics must go through `scopeGaClient` / `gscScopeFilter`
  (the client factory itself is not scoped; only `runReport` is wrapped).
- Proof: `landingAnalyticsScope.test.ts` (filters, regex boundaries, own-location rules, org members, fail-closed, caching, the client
  wrapper), `seoRoutes.landingScope.test.ts` (a deployer, `?domain=` another customer's host, the caller's own host, product metrics) and
  `seoService.landingScope.test.ts` (Emma's readers). Removing the GA wrapper or the Search Console filter from `/metrics` fails the route
  tests; removing the funnel wrapper or the `/debug` filter fails theirs.
