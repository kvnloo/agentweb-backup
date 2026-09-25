import React from "react";
import { Box, Chip, Tooltip } from "@mui/material";
import { Edit as EditIcon } from "@mui/icons-material";

interface ScoreDimensions {
  goalCompletion: number;
  dataAccuracy: number;
  outputQuality: number;
}

export interface SatisfactionScore {
  score: number;
  reason: string;
  adminOverride?: boolean;
  dimensions?: ScoreDimensions;
}

export interface JudgeScore {
  score: number;
  reason: string;
  judgeName: string;
  dimensions?: ScoreDimensions;
}

/** Why the satisfaction judges are a secondary signal (ENG-2144, ENG-2128). */
export const SATISFACTION_UNVALIDATED_NOTE =
  "LLM-judge satisfaction scores are not validated against human labels (eval registry: mayGate=false) and cover only " +
  "sessions someone opened, so they are a secondary signal. See the Eval v2 tab for sampled, graded results.";

/** Column header for the chat-history satisfaction column: labelled unvalidated. */
export function SatisfactionColumnHeader() {
  return (
    <Tooltip title={SATISFACTION_UNVALIDATED_NOTE}>
      <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, color: "text.secondary" }}>
        Satisfaction
        <Chip label="unvalidated" size="small" color="warning" variant="outlined" sx={{ height: 18, fontSize: "0.65rem" }} />
      </Box>
    </Tooltip>
  );
}

const dimSummary = (d?: ScoreDimensions) =>
  d ? ` | Goal:${d.goalCompletion} Accuracy:${d.dataAccuracy} Quality:${d.outputQuality}` : "";

/**
 * The default judge's score (clickable for an admin override), its three dimensions and each
 * custom judge's score. Neutral colours on purpose: an unvalidated 1–5 score must not read as a
 * red/green quality verdict (ENG-2144).
 */
export function SatisfactionBadges({
  score,
  judgeScores,
  onOverride,
}: {
  score?: SatisfactionScore;
  judgeScores?: Record<string, JudgeScore>;
  onOverride: (anchor: HTMLElement, score: SatisfactionScore) => void;
}) {
  const chips: React.ReactNode[] = [];
  if (score) {
    chips.push(
      <Tooltip key="default" title={`Default: ${score.reason}${dimSummary(score.dimensions)}${score.adminOverride ? " (admin override)" : ""} — unvalidated`}>
        <Chip
          label={`Default: ${score.score}`}
          size="small"
          variant={score.adminOverride ? "filled" : "outlined"}
          icon={score.adminOverride ? <EditIcon sx={{ fontSize: "0.8rem" }} /> : undefined}
          onClick={(e) => onOverride(e.currentTarget, score)}
          sx={{ cursor: "pointer" }}
        />
      </Tooltip>
    );
    if (score.dimensions) {
      const { goalCompletion, dataAccuracy, outputQuality } = score.dimensions;
      const dim = { size: "small" as const, variant: "outlined" as const, sx: { fontSize: "0.65rem", height: 18 } };
      chips.push(
        <Tooltip key="dim-goal" title="Goal completion"><Chip label={`G:${goalCompletion}`} {...dim} /></Tooltip>,
        <Tooltip key="dim-acc" title="Data accuracy"><Chip label={`A:${dataAccuracy}`} {...dim} /></Tooltip>,
        <Tooltip key="dim-qual" title="Output quality"><Chip label={`Q:${outputQuality}`} {...dim} /></Tooltip>
      );
    }
  }
  for (const [judgeId, judge] of Object.entries(judgeScores ?? {})) {
    chips.push(
      <Tooltip key={judgeId} title={`${judge.judgeName}: ${judge.reason}${dimSummary(judge.dimensions)} — unvalidated`}>
        <Chip label={`${judge.judgeName}: ${judge.score}`} size="small" variant="outlined" />
      </Tooltip>
    );
  }
  return <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>{chips}</Box>;
}
