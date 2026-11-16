# Deploy-triggered docs and CSM handoff: options memo (ENG-131)

Status: memo plus one pure slice. Nothing here publishes docs, sends messages, creates
vendor accounts, or changes the deploy workflow.

## Current state (verified on main)

- Emma's `search_user_guide` (`backend/src/emma/notionGuideTools.ts`) already searches the
  Mintlify site at docs.agentweb.pro. The chatbot KB loads Mintlify `llms-full.txt`
  (`backend/src/services/docsKnowledgeSource.ts`). The Notion corpus was retired in ENG-163.
  A Notion fallback import (`getUserGuideContent`) still exists in `notionGuideTools.ts` and
  should be checked and removed in a follow-up (acceptance criterion 6).
- ENG-7 is Done. Production deploys run from `.github/workflows/deploy.yml`, path-filtered,
  on merge to `main`.

## Decisions

1. Trigger point. Options: (a) PR merge, (b) a `workflow_run` job after `deploy.yml`
   finishes successfully, (c) an in-app startup hook. Recommended: (b). It fires only once
   the deploy is live and healthy, runs once per workflow run (the run ID is the
   idempotency key), and a failure in that job cannot roll back the deploy. (a) announces
   features before they are live. (c) runs once per instance and would double-fire.
2. Feature metadata. Options: Linear Releases, or the commit range between the last
   deployed SHA and the new one, mapped to merged PRs and then `ENG-n` issues. Recommended:
   the commit range. It needs no new Linear setup. Requester comes from the issue's
   Featurebase link when present.
3. Doc store and how Emma reads it. Keep Mintlify (`AgentWebPro/mintlify-docs`). Generated
   pages are opened as PRs against that repo in review mode. Automerge waits until the
   critic gate has a track record. Emma already reads the live site, so nothing changes there.
4. CSM handoff. An internal Slack card plus an unsent Gmail draft per requester-linked
   feature. The system never sends anything to a customer. Featurebase's built-in "shipped"
   email stays off.

## Cost

No new vendor spend. Authoring uses the existing LLM budget or Mintlify plan credits. If
Mintlify Agent automation needs a paid tier, that is a separate spend decision.

## This slice

`backend/src/utils/releaseDocsDraft.ts` is a pure function. Given a merged PR and its
Linear issue, it returns:

- whether the change is customer-facing (Feature/customer-facing label, not Infra/internal,
  and not a diff that only touches CI, docs, or tests),
- a draft docs entry (slug, title, summary, source links),
- a draft CSM note with `sendable: false` when a requester is linked,
- an idempotency key, `<issue>:<mergeSha>`, so a redeploy of the same release cannot
  produce duplicates.

## Follow-ups (separate issues)

- The `workflow_run` release job: commit-range manifest, per-feature isolation, alerts.
- A docs PR writer for `mintlify-docs` plus build, broken-link, and style-critic gates.
- CSM Slack card and Gmail draft writer, internal only.
- Remove the leftover Notion fallback in `search_user_guide`.
- Harsha reviews any generated customer copy template before it is used.
