## ENG-3165: Caller-URL SSRF refusal counted as by_design, not a create_html_template bug (2026-11-21)

The failure classifier now reads the caller-URL guard refusal ("That URL cannot be fetched. Use a public https link.") as `by_design`, so the agent-mode failure-cluster loop stops filing the guard working correctly (e.g. a loopback probe) as a tool bug. The guard is unchanged.
