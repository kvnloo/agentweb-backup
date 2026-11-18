## ENG-3087: staging-env-override.sh matches the staging environment by exact name (2026-11-16)

- `.github/scripts/staging-env-override.sh` used to accept any environment whose name contained "staging". The real backend staging environment is `Agentweb-backend-env-1`, so the script refused the only environment it was written for, and the ENG-2353 kill-switch proof could not run.
- It now runs only when `EB_ENVIRONMENT_NAME` is exactly `Agentweb-backend-env-1`. It refuses `Agentweb-backend-env-prod-3` with its own message, and refuses every other name. Both names are `readonly` constants, so no caller variable can widen the guard. A rename means editing the constant and the test.
- `AWS_REGION` now defaults to `us-west-2`. The old default, `us-east-1`, has no Elastic Beanstalk environments, so the script could not have found staging there.
- `docs/staging-env-overrides.md`: the two names are variables on the GitHub `staging` environment; the lookup is `gh variable get <name> --env staging`. Without `--env` it reports "not found".
- Tests: `.github/scripts/staging-env-override.test.sh`, 22 checks. `show` was run once against real staging (read-only) and returned no rows: no `LEAD_MAGNET_*` override is set. `set` and `restore` were not run against a real environment.
