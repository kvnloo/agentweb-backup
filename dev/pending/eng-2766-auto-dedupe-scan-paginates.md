## ENG-2766: Auto-issue dedupe scans every open canonical, not just the newest 50 (2026-10-29)

`fileAutoIssue` matched recurrences against `listOpenIssuesByLabel('Auto', 50)`, which returned only the newest 50 open Auto issues. With ~70 open, older canonicals (e.g. ENG-2374, a Meta "cannot be read — token invalid" issue from Oct 9) fell out of the candidate set, so each Meta connection handoff filed a parallel issue (ENG-2753/2755/2756/2762/2765). `listOpenIssuesByLabel` now pages through all open matches (100/page, 1000 cap); both intake call sites drop the 50 cap. No schema/data change.
