## ENG-2840: Three security fixes in Emma's tools: lead lookup ownership, LinkedIn upload downloads, HubSpot write labels (2026-11-26)

- `find_or_lookup_email` (`emma/emailLookupTool.ts`): with `leadId` + `listId` it loaded the lead by key with no ownership check, so any
  caller holding both ids (including through text an agent was fed) got another tenant's lead email, name, company and LinkedIn. The lead
  is now read only from a list the caller may read (`canAccessCrmList`); otherwise it is treated like a missing lead.
- `call_linkedin_marketing_api` MEDIA uploads (`emma/impl/adsApis.ts`): any key of our bucket was presigned for any caller, and any other
  URL was downloaded with a plain GET (no SSRF guard, no size cap, no timeout). Now a file of our bucket is read only when the storage rule
  lets this caller read that key (`checkOurBucketKeyRead`), through the SDK with a byte ceiling; any other URL goes through the
  SSRF-guarded caller-URL fetch with a byte ceiling and a time limit (`LINKEDIN_UPLOAD_MAX_BYTES`: image 20 MB, document 100 MB, video
  200 MB; 60 s, 120 s, 180 s).
- Emma's tool gateway (`services/agentToolGatewayService.ts`) labelled `call_hubspot_api` SUBMIT, ENABLE, UNPUBLISH, DISABLE, ADD_ASSET and
  REMOVE_ASSET as reads (safe to repeat, no confirmation flag). They are now writes (ENABLE external_publish, SUBMIT external_send,
  UNPUBLISH destructive, the others internal_write), only the known reads are reads, and an unknown action is a write.
- Found in the W2-9 research (brain `eng-2840-w29-research-2026-11-26.md`). Not changed here: the portal's `/api/crm/leads/find-email`
  pools other tenants' stored emails by its locked design; it is not exposed over MCP.
- Proof: `emma.emailLookupTool.test.ts` (another tenant's list is never read), `linkedInAds.agentMode.test.ts` (guarded fetch with
  ceilings, own-bucket rule, refusals), `agentToolGateway.hubspotEffects.test.ts`. Known unrelated failure on main:
  `emmaToolArgContracts.test.ts` "leaves unknown endpoints..." fails on origin/main 345ef0983 without this change.
