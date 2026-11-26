## ENG-2840: Log-only audit of reads through the shared Google service account (2026-11-26)

- Two places let a caller name a Google resource that nothing proves they own, then read it with AgentWeb's OWN Google service account:
  `readGoogleFileById` (a `gdoc:<id>` / `gsheet:<id>` knowledge-base identifier, the `read_knowledge_base_files` MCP tool, Emma's Google file
  reader) falls back to the service account when the caller has no Google Drive login or their own login is refused (401/403), with no check
  that the caller owns or registered the file; and the analytics readers read the GA4 property ids and Search Console domains SAVED in a user's
  or organization's analytics config, which `analyticsConfigValidator.ts` checks for format only (GA4 property ids are plain numbers).
- This change is step 1 of a two-step fix and changes nothing a customer can do: it writes one structured `shared_google_read` line per resource
  to the application log (`services/sharedGoogleAudit.ts`): `kind` (`drive-file`, `ga4`, `gsc`), `userId`, `idHash` (12 hex characters of a
  SHA-256 of the id: the raw id is never logged), `source` (the function or route), and for Drive `reason` (`no_oauth`: no Google login;
  `oauth_denied`: the caller's own login was refused) and `outcome` (`ok`, `failed`). Hooked in `readGoogleFileById`, the three `seoService`
  readers (`fetchGa4KeyEvents`, `fetchGoogleAnalyticsMetrics`, `fetchSearchConsoleMetrics`) and the portal's `GET /api/seo/metrics` and
  `GET /api/seo/product-metrics` (which read inline). It never throws and never changes what a read returns.
- Reading the numbers (CloudWatch Logs Insights, log group `/aws/elasticbeanstalk/Agentweb-backend-env-prod-3/var/log/web.stdout.log`):
  `filter audit = "shared_google_read" | stats count_distinct(userId) as users, count(*) as reads by kind, idHash | sort users desc` shows any
  resource read by more than one account (the cross-tenant signal); `filter audit = "shared_google_read" and kind = "drive-file" | stats
  count(*) as reads, count_distinct(userId) as users by reason, outcome` shows how many Drive reads rely on the fallback at all and for how many
  accounts. Step 2 (enforcement: only ids the caller registered or can open with their own Google login; a property or domain is saved only
  when the customer's own Google login can see it) waits for those numbers, and its refusal text is customer-facing copy for Harsha to review.
- Known limits of the log: it records the id the caller used, not who owns the resource (that needs an extra Drive call per read, left out so
  the existing Drive tests and behaviour stay byte-identical); the same account reading its own shared file is indistinguishable from a
  cross-account read except by the "same hash, several accounts" query above.
