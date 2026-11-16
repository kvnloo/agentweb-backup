## ENG-3029: Grok creator alias rolled back; the entry below this one is partly wrong (2026-11-16)

- Correction to the ENG-3029 entry dated 2026-11-16 ("Grok rows match again"): the `SpaceXAI` -> `xai` alias in `refreshScores` (`AA_CREATOR_ALIASES`) was merged in #4095 and removed the same day in #4097. Grok rows do not match. The live fixture from that entry is unchanged.
- Why: with the alias, monitor workflow run 43787084872 matched `grok-4.7` and proposed 46.4 -> 35.5 from the feed while `grok-4.6` stayed unmatched at 44.3, and the "Grok 4.7 supersedes 4.6" invariant failed the run. The feed is Intelligence Index v5; the registry's older scores are on an earlier scale.
- Do not re-add the alias before the score-scale mix is decided (ENG-3054).
