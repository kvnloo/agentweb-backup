## ENG-2263: CRM freshness detector reads "a combined count of N leads" as a total claim (2026-10-09)

A scheduled-run test on the preview showed the log-only detector (PR #3351) missing a wrong sum phrased "97 lead lists in total, containing a
combined count of 12,746 leads" (real sum 15,486): only "a total of N leads" was a covered wording. The pattern now also accepts
"combined / overall / aggregate count|total|number of N leads", still requiring CRM wording nearby and still backed by the turn's tool numbers.
Replaying the ~270 saved A/B replies shows no change (110/129 failing flagged before and after; 6/82 correct flagged before and after), so no new
false alarms there. Log-only; the reply is never edited.
