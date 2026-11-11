## ENG-2936: Same-email re-submits keep per-submission history (2026-11-11)

forward-lead merge now appends notes instead of replacing them, and logs one AW-ContactEvents `form.submitted` row per distinct submission (payload: page URL, notes, full fields, overwritten prior values). Retries with the same submissionId dedupe. No new table/index; merge held for Harsha (data-plane rule).
