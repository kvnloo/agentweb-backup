## ENG-2574: save_memory / save_org_memory auto-split content over 2000 chars (2026-10-19)

Content of 2001-8000 code points is now split at paragraph/sentence boundaries into rows of 2000 or fewer, instead of being schema-rejected (8 agent_tool_failed rows, 10-14..10-19). The schema ceiling is now 8000. The per-row addMemory guard is unchanged.
