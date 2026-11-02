## ENG-589: agent-mode failure clusters auto-file Linear issues via the ENG-240 rail (2026-11-02)

- `ClusterIntakeTool` replaces the bare `SpecOutputTool` in the agent-mode loop: each major `toolName × failureType` cluster (existing count+rate thresholds) files one `Auto` issue through `fileAutoIssue` with `Alert Class: agent-mode:<tool>:<failureType>`, cluster stats, up to 3 sample traces, and an AC stub. Open canonical → occurrence comment; closed canonical → reopen (`findMostRecentClosedIssueByLabel`); always `human-triage`.
- Runs only when the 17:30 UTC loop runs (`AGENT_MODE_LOOP_ENABLED`); non-prod filing stays suppressed by ENG-1099.
