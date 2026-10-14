## ENG-2135: AI-written golden-set labels never count as human agreement (2026-10-14)

On 2026-10-14, with the owner's permission, a Claude model wrote 72 golden-set labels (43 creative pairwise choices and 29 agent
`task_success` labels). Each carries a note starting `[AI-LABEL]`; the store records the saving admin as the labeller, so that note is
the only marker. The validation harness and the creative calibration report treated every label as human, so a later run could have
produced a registry-shaped "validation" from AI labels, which is the evidence a reviewer pastes into `evalRegistry.ts` to let a judge
gate or alert.

- `isAiLabelled` / `AI_LABEL_NOTE_PREFIX` (`goldenSet.ts`): a case whose note starts with the marker.
- `runValidation` leaves those cases out by default. `includeAiLabels` (CLI `--include-ai-labels`) adds them for an advisory run: the
  result reports `labelSource: 'human+ai'` and `validation: null`, so it can never be recorded as registry evidence.
- `creativeCalibrationReport` leaves AI-written choices out by default, prints how many were left out, and with `--include-ai-labels`
  marks the report "ADVISORY, not human agreement".
- Not changed: stored labels, the label API, flags, `mayGate` for any grader. A label written without the marker is still treated as
  human, so anyone writing labels for the owner must keep the marker.
