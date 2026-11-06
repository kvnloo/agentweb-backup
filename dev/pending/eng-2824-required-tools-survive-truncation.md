## ENG-2824: required tools survive maxTools truncation (2026-11-05)

callLLM truncated tool lists to a model's maxTools with a plain slice, so a scheduled
run's required tool (Phoenix schedule: slack_send_message) past position 128 on
gemini-3.8-flash was never declared and the run failed validation. The truncation now
keeps the schedule's requiredFunctionCalls first (`backend/src/utils/boundToolsForModel.ts`).
