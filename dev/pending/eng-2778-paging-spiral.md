## ENG-2778: Paging-spiral detection for agent loop (2026-11-02)

Agent loop now nudges once per turn when the same tool+target is paged >=5 times with varying offset/limit (evaded exact-signature anti-loop guards). Partial fix: fixes 1,2,4,5 from the issue remain open.
