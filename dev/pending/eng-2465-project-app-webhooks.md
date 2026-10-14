## ENG-2465: the HubSpot app's webhook subscriptions can only be changed in its HubSpot project (2026-10-14)

**Found in production after #3537.** The boot registration of `contact.merge` failed: HubSpot answered `403 BANNED / AppProjectAssociationErrors.PROJECT_BASED_APP_WEBHOOK_EDIT_ERROR`: the AgentWeb app was created by the project `agentweb_hubspot`, so its webhook configuration "can't be edited through the API or UI"; it has to be changed in the project's webhook config file and the project redeployed. My earlier statement that the backend could register subscriptions itself was wrong for this app. The same 403 applies to the config-save path (`routes/crmSync.ts`) and to any mapped-custom-property subscription it tried to add.

**Effect.** Nothing was broken (the contact.merge handlers are inert until the event arrives), but every deploy burned 5 queue attempts on a request that can never succeed and logged 5 errors.

**Fix.** `ensureWebhookSubscriptions` recognises that specific 403, logs ONE warning naming the subscriptions that still have to be added to the project's webhook configuration, skips the remaining POSTs, and reports "nothing this code can do" so the build completes instead of retrying. Any other failure (other 403s, 429, 5xx, timeouts) still fails the build's claim and is retried as before.

**Still to do by hand.** Add the `contact.merge` subscription to the `agentweb_hubspot` project's webhook configuration and redeploy the project; until then merges in HubSpot are not delivered to us, and the stored-id push fails closed on a merged-away id as before.
