## ENG-2677: auto-post successful prod backend deploys to #feature-launches (2026-10-26)

- New `notify-feature-launch` job in `deploy.yml` runs after a successful `backend-deploy` and posts PR numbers, titles and ENG ids shipped since the previous successful deploy (`detect-changes.outputs.base_sha`) plus the run URL.
- Channel: repo variable `FEATURE_LAUNCHES_CHANNEL`; unset -> notice + skip. The Emma bot must be invited to the channel (no `channels:join`).
- Separate job; cannot gate or roll back the deploy. Slack `ok:false` fails only this job. Tests: `.github/scripts/deploy-launch-notify.test.sh`.
