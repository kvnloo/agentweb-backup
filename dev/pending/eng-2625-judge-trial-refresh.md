## ENG-2625: judge trial refresh (2026-10-22)

- `EVAL_REGISTRY.md` now records the rerun of the task-success judge trial on the refreshed work-plan golden set:
  - Judge vs GPT-5.4 labels: test kappa 0.83, dev 0.58, all 0.73.
  - The judge stays advisory.
- `runTaskSuccessJudgeTrial.ts` retries a call that a provider refuses with a 400 once more, with that provider ignored, so OpenRouter serves the model from another provider.
  - Why: Azure refused one GPT-5.4 labeller case every time, while OpenAI and Bedrock also serve the model.
