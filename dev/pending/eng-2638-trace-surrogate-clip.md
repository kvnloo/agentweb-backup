## ENG-2638: trace text caps no longer split an emoji (2026-10-23)

**Why.** Every provider rejected the GPT-5.4 labeller request for golden case `fb513a4b`. Azure and OpenAI returned `invalid_json`, and Bedrock returned `validation_error`. The trace had capped a reply in the middle of an emoji, leaving a lone UTF-16 surrogate, which JSON can't carry. Of the 80 work-plan golden cases, only this one was affected.

**What.**
- `cutWithoutSplittingPair` in `agentRunTrace.ts` drops a dangling high surrogate after cutting.
- It is used by `capRedacted`, for every capped trace text, and by `clip` in the judge prompt.
- The ENG-2625 provider-refusal retry in `runTaskSuccessJudgeTrial.ts` is removed. It assumed Azure was refusing the case, which the diagnosis disproved.
- `agentRunTrace.ts`: stored rows are typed as `unknown`, not `any`. The file is now lint-clean.
