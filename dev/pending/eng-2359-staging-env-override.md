## ENG-2359: backend staging env-override script for post-merge proofs (2026-10-08)

Added `.github/scripts/staging-env-override.sh` (+ test, wired into tests.yml) and `docs/staging-env-overrides.md`: set/restore allowlisted env vars on the staging EB env only, with an ENG-2353 proof recipe.
