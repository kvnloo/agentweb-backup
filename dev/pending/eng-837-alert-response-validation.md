## ENG-837: Reject empty or streamed deploy-alert JSON (2026-11-15)

Deploy-failure notification validates exactly one JSON object at both external JSON boundaries (Secrets Manager secret and Slack response). jq 1.6 can exit zero on whitespace-only input; slurping and checking object count keeps the delivery diagnosis accurate. No credential, deploy policy, or production data changed.
