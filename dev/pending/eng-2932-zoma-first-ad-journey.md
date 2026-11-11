## ENG-2932: Zoma first-ad journey mocked E2E harness (2026-11-11)

Added `backend/src/__tests__/eng2932.zomaFirstAdJourney.test.ts`: fresh org -> Meta connect -> campaign/ad set/ad CREATE -> launch, against an in-memory Meta Graph shared by dispatch and read-back. Covers happy path, Meta-rejected ad create, failed enable, and silently-unapplied enable (MISMATCH). No product code change; no bugs found on these paths.
