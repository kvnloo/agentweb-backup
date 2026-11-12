## ENG-2944: merge-evidence.sh names Opslane carry-forward failures (2026-11-11)

- `merge-evidence.sh` pass 5b logs `OPSLANE_CARRY_FORWARD: <id> <url> — not a re-test of <head>; see ENG-2749` when an Opslane `failure` completed in <= `MERGE_EVIDENCE_OPSLANE_CARRY_FORWARD_SECONDS` (default 2). Diagnostic only: the run still blocks; exit codes unchanged. Policy stays with ENG-2749.
- Tests: `bash .github/scripts/merge-evidence.test.sh` (143/143), 4 new fixtures.
