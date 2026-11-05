## ENG-2828: Extract ZomaProvider interface (2026-11-05)

Behavior-preserving refactor. `backend/src/mcp/zomaProvider.ts` defines the per-platform seam
(platform id, curated tool names, account lookup for the caller, metering platform tag, setup
status + connect link, guarded-write surface). `metaZomaProvider.ts` adapts the existing Meta
toolkit modules (no logic re-implemented) and `zomaProviderRegistry.ts` registers Meta as the
only provider. The toolkit routes' `tools/list` and the gateway's `account_id` schema check now
read through the registry; output is identical (pinned by `eng2828.zomaProviderRegistry.test.ts`).
The provider loads the gateway/onboarding modules lazily so tools/list stays pure and the
gateway → registry → provider edge is not an import cycle. The metering tag is descriptive only;
no usage-event schema change (data-plane gate).
