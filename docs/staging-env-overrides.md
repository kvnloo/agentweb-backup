# Backend staging env overrides (ENG-2359)

Post-merge verifiers use this to prove kill-switch / ceiling paths on backend
staging instead of production. Script: `.github/scripts/staging-env-override.sh`.
It runs only when `EB_ENVIRONMENT_NAME` is exactly the backend staging
environment name, `Agentweb-backend-env-1`. It refuses production
(`Agentweb-backend-env-prod-3`) and every other name, and exits 2 before any
AWS call. Both names are constants in the script; if an environment is renamed,
change the constant and its test together (ENG-3087).

It only accepts allowlisted keys (`LEAD_MAGNET_EXECUTE_DISABLED`,
`LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY`). Extend `ALLOWED_KEYS` in the script
(with a test) to add more.

The two names are variables on the GitHub `staging` environment, not on the
repository, so `gh variable get <name>` without `--env` reports "not found". Look them
up with `--env staging`:

```bash
export EB_ENVIRONMENT_NAME="$(gh variable get EB_BACKEND_STAGING_ENVIRONMENT_NAME --env staging --repo AgentWebPro/agentweb)"
export EB_APPLICATION_NAME="$(gh variable get EB_BACKEND_STAGING_APPLICATION_NAME --env staging --repo AgentWebPro/agentweb)"

bash .github/scripts/staging-env-override.sh set LEAD_MAGNET_EXECUTE_DISABLED=true
bash .github/scripts/staging-env-override.sh show
bash .github/scripts/staging-env-override.sh restore LEAD_MAGNET_EXECUTE_DISABLED
```

`AWS_REGION` defaults to `us-west-2`, where both backend environments run.
`show` prints one line per `LEAD_MAGNET_*` override and prints nothing when
none is set.

Each `set`/`restore` waits for the environment to return to `Ready`; EB
restarts the app, which also clears the per-process lead-magnet rate-limit
counters, so each probe starts from zero. Always `restore` when done.

## No-spend guarantee for lead-magnet execute

`POST /api/lead-magnet/execute` only writes a `pending` TaskExecution row
(userId `lead-magnet-*`); nothing in `backend/src` consumes those rows, so a
staging call incurs no agent-engine/LLM spend. Re-check this
(`git grep -n "lead-magnet-" backend/src`) if an executor is ever wired up.

## ENG-2353 proof recipe

1. `set LEAD_MAGNET_EXECUTE_DISABLED=true` -> `POST /api/lead-magnet/execute`
   returns 503 and no TaskExecution row is created. `restore` it.
2. `set LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY=1` -> first call 200; second call
   with a different email and `X-Forwarded-For` returns 429
   ("Free task capacity reached"). `restore` it.

Required IAM: `elasticbeanstalk:UpdateEnvironment`, `DescribeEnvironments`,
`DescribeConfigurationSettings` on the staging environment only.
