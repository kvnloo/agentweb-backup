## ENG-527: Product-feedback filing is never token-limited (2026-10-13)

- New `services/productFeedbackFiling.ts` is the one shared filing policy (title normalization, replay guard, durable fingerprint) used by `POST /api/support/report-ui-bug` and Emma.
- `agentModeController.generateResponse`: when over quota and the request carries `feedbackIntent: 'bug' | 'feature_request'`, the message is filed deterministically (zero LLM calls) and the tracked link returned; failures answer 502/503 `feedback_filing_failed` and never claim tracking. Ordinary over-quota generation keeps its 429.
- Follow-up: the customer portal must send `feedbackIntent` from a Report bug / Request feature affordance.
