## ENG-3082: eb-deploy.sh no longer fails a serving release whose version label has not moved (2026-11-16)

- `.github/scripts/eb-deploy.sh`: when the deploy budget runs out with the environment `Updating` on the previous version label, `verify_deployment` now calls `release_serving_while_old_instances_terminate` before failing. It reports success only if all three hold: EB's events show "Deployment succeeded. Terminating old instances and temporary Auto Scaling group." after the last "Environment update is starting." since our update was accepted; at least one instance reports the expected version as `Deployed` with health `Ok`; and each such instance is `healthy` in a load-balancer target group.
- The check runs only at the point where the deploy would otherwise fail. It never ends a deploy early.
- It uses calls the script already makes (`describe-events`, `describe-instances-health`, `describe-environment-resources`, `describe-target-groups`, `describe-target-health`). The instance read adds the `Deployment` attribute to the same API action.
- Cause on 2026-11-16 (run 43832897163): EB moves the environment's version label only when the old instance is gone, which took 17 minutes; the run had also waited 18 minutes behind an earlier update.
- Tests: `.github/scripts/eb-deploy.test.sh`, section ENG-3082 (14 checks; 123 in total).
