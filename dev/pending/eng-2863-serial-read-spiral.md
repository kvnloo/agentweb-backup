## ENG-2863: Batch-lookups nudge for serial single-read steps; LinkedIn reads no longer reported as writes (2026-11-07)

- New `backend/src/services/agentMode/core/serialReadSpiral.ts`: after 6 consecutive steps that each issued one read-only tool call, inject one system nudge per turn telling the model to batch independent lookups into one response. Prod session 5bfb9d06 (Every.io Daily ICP Lead Finder) spent 39 of 40 steps this way.
- `isWriteToolCall` now treats `linkedin_outreach` discovery actions (search-people, get-profile, get-company, search-parameters, list-*) as reads; unknown/missing actions stay writes. The iteration-limit report previously listed 26 LinkedIn profile reads as "completed tool writes".
