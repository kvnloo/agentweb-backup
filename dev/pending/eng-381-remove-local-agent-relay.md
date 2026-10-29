## ENG-381: Remove retired local-agent-relay package and its CI build (2026-10-29)

- Deleted `local-agent-relay/` (the ngrok-hosted Codex relay, retired since 2026-07-17; tools deprecated under ENG-383) and its non-required `Local agent relay build` CI job/path filter.
- Inventory: no backend code reads `*/AgentWeb/LocalAgentRelay`; `run_local_agent_task`/`check_local_agent_status` remain only as ENG-383 deprecation stubs that reject with redirect guidance.
- Rollback: revert this commit.
