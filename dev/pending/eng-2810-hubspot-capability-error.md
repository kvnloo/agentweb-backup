## ENG-2810: HubSpot Marketing Hub refusals classified as config (2026-11-04)

- `classifyToolFailureType` now maps the hubspotMarketingPreflight "portal does not have Marketing Hub" / "authorised for CRM access only" refusals to `config` instead of `bug`, so the agent-mode failure-cluster loop stops filing handler-bug issues for a portal-plan/grant gap.
