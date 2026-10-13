## ENG-2138: the shadow outcome judge keeps its one-decimal score (2026-10-13)

`scoreSessionWithJudge` rounded every judge score to a whole number. The original ENG-1710 rubric B asks for a one-decimal
score and was measured on those decimals (a 5 counted at >= 4.95). On the ENG-1710 corpus, with the labels rebuilt in ENG-2410
(comments on ENG-2138, 2026-10-12), the cached scores read AUC 0.76 / 3.4% at 5 raw and AUC 0.72 / 46% at 5 once rounded, so
no integer-scale replay (ENG-2356, ENG-2380, the prod shadow scores) could meet the "< 15% at 5" bar. The committed
reconstructed-3 rubric asks for whole numbers, so this change does nothing to it; it matters once a decimal rubric is the
shadow judge's prompt.

- A shadow judge now stores `Math.round(score * 10) / 10`, clamped to 1-5. Customer-facing judges still store whole numbers.
- `scripts/evalOutcomeJudge.ts` counts a 5 as a score of at least 4.95, matching ENG-1710.
- The fabrication and awaiting-reply guards only use `min`/`max`, so they work on decimals.
- Readers of `judgeScores[outcome-judge-b-shadow]` (`evalAgentGraders`, `runValidation`, the MCP session tool) use the
  `dimensions` or pass the object through; none assumes an integer `score`.
- Existing stored shadow scores are whole numbers and stay as they are; no data is rewritten.
