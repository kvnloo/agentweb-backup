## ENG-2888: pure truncated-run credit classifier, dark (2026-11-10)

Added `backend/src/services/agentMode/core/truncatedRunCredit.ts`: classifies finished agent-mode runs (completed / truncated_iteration_limit / failed_before_effect / failed_after_partial_effect) and proposes a credit treatment. Dark: not wired into billing; default config charges full for every class. Wiring + policy are ENG-2836.3.
