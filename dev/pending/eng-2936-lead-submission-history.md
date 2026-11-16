## ENG-2936: Same-email re-submits keep per-submission history (2026-11-11)

forward-lead merge now appends notes instead of replacing them, and logs one AW-ContactEvents `form.submitted` row per distinct submission (payload: page URL, notes, full fields, overwritten prior values). Retries with the same submissionId dedupe. No new table/index; merge held for Harsha (data-plane rule).

2026-11-16: the notes compare-and-set retry now lives in `mergeWithNotesRetry` (`utils/leadSubmissionHistory.ts`): up to 8 attempts with a jittered, doubling wait (ceiling 400 ms) before each re-read. With 5 back-to-back attempts, one of six concurrent appends on `Dev-AW-Leads` ran out of attempts in 4 of 6 runs.
