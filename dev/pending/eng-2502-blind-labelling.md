## ENG-2502: Blind human labelling pages (2026-10-15)

- `/eval-labelling` and `/eval-labelling/calibration` now show a case whose notes start with `[AI-LABEL]` as unlabelled: no stored labels, notes or draft suggestions, not counted as labelled, not skipped by "next unlabelled". A human save replaces the AI label as before.
- Front-end only (`partner-portal/src/utils/blindLabelling.ts`); no backend or data change.
