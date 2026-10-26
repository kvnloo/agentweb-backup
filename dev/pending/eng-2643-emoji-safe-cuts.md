## ENG-2643: Emoji-safe text cuts in the creative rubric judge and knowledge-base tool results (2026-10-23)

- Moved `cutWithoutSplittingPair` to `backend/src/utils/surrogateSafeCut.ts` (re-exported from `agentRunTrace`), added `truncateToolContent`.
- `creativeRubricJudge` brief-field clip and landing-page source cut, and all seven knowledge-base/Foreplay 5000-char tool-result cuts, no longer leave a lone surrogate half.
