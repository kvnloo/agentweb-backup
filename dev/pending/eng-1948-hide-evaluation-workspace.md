## ENG-1948: Hide evaluation_workspace from principals that can only be denied (2026-10-31)

Agent Mode tool listing now omits `evaluation_workspace` for non-admin, delegated, interactive-share, unattended/scheduled and sandbox principals. Execute-time EvaluationDenied checks unchanged.
