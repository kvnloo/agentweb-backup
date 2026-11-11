## ENG-2891: pure versioned campaign-playbook model + validator/diff, shadow-only (2026-11-09)

`backend/src/services/marketingPlaybook.ts`: `validatePlaybook` (semver, unknown actions, duplicate step ids, high-risk steps need an ENG-2890-provable rollback) and `diffPlaybooks`. Dark: no persistence, not wired into any runtime path.
