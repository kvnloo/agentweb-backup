## ENG-2840: Log-only audit of reads through the shared Google service account (2026-11-26)

- Where a caller names a Google resource that nothing proves they own, and AgentWeb's OWN Google service account then reads it:
  `readGoogleFileById` (a `gdoc:<id>` / `gsheet:<id>` knowledge-base identifier, the `read_knowledge_base_files` MCP tool, Emma's Google file
  reader) falls back to the service account when the caller has no Google Drive login or their own login is refused (401/403), with no check
  that the caller owns or registered the file; the analytics readers read the GA4 property ids and Search Console domains SAVED in a user's or
  organization's analytics config, which `analyticsConfigValidator.ts` checks for format only (GA4 property ids are plain numbers); and
  registered Google Drive folders (`POST /api/settings/google-drive/folders` checks only that the service account can see the folder) are read
  with the service account by the knowledge-base search, listing, reading and materializing code and by the folder-files route.
- This change is step 1 of a two-step fix and changes nothing a customer can do: it writes one structured `shared_google_read` line per
  configured resource per call to the application log (`services/sharedGoogleAudit.ts`): `kind` (`drive-file`, `ga4`, `gsc`), `userId`, `idHash`
  (12 hex characters of a SHA-256 of the id; a Search Console property is first lowercased and stripped of its scheme, trailing slash and
  `sc-domain:` prefix, so the forms of one site share a hash; this also merges an http and an https URL-prefix property and a domain property
  of the same site, which Google treats as separate, erring toward more matches), `source` (the function or route), then when known `orgId` (analytics lines only: the
  Drive reader does not know the caller's organization), `configSource` (`self`: the caller's
  own config; `org`: the organization's, shared with a member), `platform` (true when the id is one of the platform's own landing-page GA4
  properties or Search Console domains from `getLandingPagesConfig`, which deploying a landing page adds to the deployer's config; the list is
  loaded in the background at most every 10 minutes whether or not the load works; until a load works, lines carry no `platform`, never
  `false`), for Drive `reason` (`no_oauth`,
  `oauth_denied`) and `outcome` (`ok`, `failed`), and `ofIds` when one call read several. Hooked in `readGoogleFileById`, the three `seoService`
  readers, the portal's `GET /api/seo/metrics` (including the platform landing-page property it adds for a host named in `?domain=`),
  `GET /api/seo/product-metrics`, and the GA4 probe `POST /api/seo/config/ga/test` (any numeric property id the caller names; not hooked:
  `GET /api/seo/debug`, which reads the first configured domain that `/metrics` already logs). It never throws and never changes what a read returns or asks Google.
- Reading the numbers: CloudWatch Logs Insights on `/aws/elasticbeanstalk/Agentweb-backend-env-prod-3/var/log/web.stdout.log`. The lines carry
  a syslog prefix, so fields are parsed from `@message` (a plain `filter audit = ...` matches nothing). Resources read by several accounts,
  the platform's own ids left out:
  `fields @message | filter @message like /"audit":"shared_google_read"/ and @message not like /"platform":true/ | parse @message /"kind":"(?<kind>[^"]+)","userId":"(?<userId>[^"]+)","idHash":"(?<idHash>[0-9a-f]+)"/ | stats count_distinct(userId) as users, count(*) as lines by kind, idHash | sort users desc`.
  Lines written before the platform list loaded carry no mark, so take the platform hashes out by hash as well: list them with
  `fields @message | filter @message like /"platform":true/ | parse @message /"idHash":"(?<idHash>[0-9a-f]+)"/ | stats count(*) by idHash`.
  A hash with several users is legitimate when they are all members of one organization: list them with
  `fields @message | filter @message like /"idHash":"<hash>"/ | parse @message /"userId":"(?<userId>[^"]+)"/ | parse @message /"orgId":"(?<orgId>[^"]+)"/ | stats count(*) by userId, orgId`.
  Drive lines have no `orgId`; join their userIds to organizations offline. Drive fallback use:
  `fields @message | filter @message like /"audit":"shared_google_read"/ and @message like /"kind":"drive-file"/ | parse @message /"userId":"(?<userId>[^"]+)"/ | parse @message /"reason":"(?<reason>[^"]+)","outcome":"(?<outcome>[^"]+)"/ | stats count(*) as reads, count_distinct(userId) as users by reason, outcome`.
  Registered Drive folders are counted from the stored registrations (user and organization `googleDriveFolders`), not from this log.
- Known limits: a line is written per CONFIGURED id per call, also when a filter narrows the read to one id, when the read then fails, and
  for a portal request answered 400, so `users` counts are right and `lines` overstate reads; `no_oauth` also covers a failure to build the
  caller's Drive client, and `oauth_denied`/`failed` also covers a failure to build the service-account client; the hash keeps raw Drive file
  ids out of the log but is not secret for GA4 property ids and domains (raw domains are already logged by the Search Console reader); the
  line records the id used, not who owns the resource. Step 2 (enforcement: only ids the caller registered or can open with their own Google
  login; a property or domain saved only when the customer's own Google login can see it; folders likewise) waits for these numbers, and its
  refusal text is customer-facing copy for Harsha to review.
- Found while auditing, pre-existing and reported separately (not changed here): the platform landing-page GA4 property and Search Console
  domain are read without a limit to the caller's own landing-page hosts (for a host named in `?domain=`, and for every user whose config
  received them on deploy).
