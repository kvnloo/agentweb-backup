import React, { useEffect, useState } from "react";
import axios from "axios";
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl } from "../../config";

/** Mirrors backend/src/loops/eval/evalV2Sampler.ts (ENG-2144). */
interface Interval {
  low: number;
  high: number;
}

interface EvalV2Metric {
  graderId: string;
  versions: number[];
  n: number;
  passes: number;
  rate: number | null;
  ci: Interval | null;
  notApplicable: number;
  mayGate: boolean;
}

interface EvalV2Group {
  surface: string;
  taskType: string;
  model: string;
  sessions: number;
  metrics: EvalV2Metric[];
}

interface EvalV2Snapshot {
  date: string;
  windowLabel: "1d" | "7d";
  windowStartDate: string;
  windowEndDate: string;
  sessions: number;
  coverage: Array<{ date: string; frameSize: number; sampleSize: number; scored: number }>;
  groups: EvalV2Group[];
}

interface GraderInfo {
  id: string;
  version: number;
  measures: string;
  mayGate: boolean;
}

interface EvalV2TrendResponse {
  windowLabel: "1d" | "7d";
  samplerEnabled: boolean;
  hasData: boolean;
  graders: GraderInfo[];
  snapshots: EvalV2Snapshot[];
}

const GRADER_LABELS: Readonly<Record<string, string>> = {
  "agent-task-success": "Task success",
  "agent-tool-correctness": "Tool correctness",
  "agent-groundedness-offline": "Groundedness",
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

function MetricCell({ metric }: { metric: EvalV2Metric | undefined }) {
  if (!metric || metric.rate === null || !metric.ci) {
    return <Typography variant="body2" color="text.secondary">– (n=0)</Typography>;
  }
  return (
    <Tooltip title={`${metric.passes} of ${metric.n} passed; ${metric.notApplicable} not applicable. 95% Wilson interval.`}>
      <Box component="span">
        <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
          {pct(metric.rate)}
        </Typography>{" "}
        <Typography variant="caption" component="span" color="text.secondary">
          [{pct(metric.ci.low)}–{pct(metric.ci.high)}] n={metric.n}
        </Typography>
      </Box>
    </Tooltip>
  );
}

function ValidationChip({ grader }: { grader: GraderInfo }) {
  return grader.mayGate ? (
    <Chip label="validated" size="small" color="success" variant="outlined" />
  ) : (
    <Tooltip title="Not validated against human labels (eval registry mayGate=false): may not alert, gate or be a headline metric.">
      <Chip label="unvalidated" size="small" color="warning" variant="outlined" />
    </Tooltip>
  );
}

const metricOf = (group: EvalV2Group, graderId: string) => group.metrics.find((m) => m.graderId === graderId);

/**
 * Online eval sampler results (ENG-2144): a uniform random daily sample of completed sessions,
 * graded by the deterministic agent graders. Every rate shows n and a 95% CI, and every grader
 * carries its validation state; none is validated yet, so none is shown as a headline.
 */
export default function EvalV2Tab() {
  const { token } = useAuth();
  const [windowLabel, setWindowLabel] = useState<"1d" | "7d">("7d");
  const [data, setData] = useState<EvalV2TrendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("Admin authentication is required.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    axios
      .get(buildApiUrl(`/api/admin/loops/eval-v2-trend?days=30&window=${windowLabel}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => {
        if (!cancelled) setData(response.data);
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError?.response?.data?.message || requestError?.message || "Failed to load eval results.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, windowLabel]);

  const graders = data?.graders ?? [];
  const latest = data?.snapshots[data.snapshots.length - 1];
  const unvalidated = graders.filter((g) => !g.mayGate);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
        <Box>
          <Typography variant="h6">Eval v2 — online sample</Typography>
          <Typography variant="body2" color="text.secondary">
            A uniform random sample of each day's completed sessions, graded without an LLM. Independent of which
            sessions anyone opened.
          </Typography>
        </Box>
        <ButtonGroup size="small">
          {(["7d", "1d"] as const).map((w) => (
            <Button key={w} variant={windowLabel === w ? "contained" : "outlined"} onClick={() => setWindowLabel(w)}>
              {w === "7d" ? "7 days" : "1 day"}
            </Button>
          ))}
        </ButtonGroup>
      </Box>

      {loading && <CircularProgress size={24} />}
      {error && <Alert severity="error">{error}</Alert>}

      {data && !loading && (
        <>
          {unvalidated.length > 0 && (
            <Alert severity="warning" data-testid="eval-v2-unvalidated-banner">
              {unvalidated.length === graders.length ? "All graders are" : `${unvalidated.length} graders are`} unvalidated:
              no grader has been checked against human labels yet, so these rates are for inspection only and drive no
              alert (ENG-2128 principle 2).
            </Alert>
          )}
          {!data.samplerEnabled && (
            <Alert severity="info">
              The sampler is off (EVAL_V2_SAMPLER_ENABLED); enabling it in production is OPS-7 (ENG-2152).
            </Alert>
          )}

          <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
            {graders.map((g) => (
              <Box key={g.id} sx={{ display: "flex", alignItems: "center", gap: 1 }} data-testid={`eval-v2-grader-${g.id}`}>
                <Tooltip title={g.measures}>
                  <Typography variant="body2">
                    {GRADER_LABELS[g.id] ?? g.id} <Typography component="span" variant="caption" color="text.secondary">v{g.version}</Typography>
                  </Typography>
                </Tooltip>
                <ValidationChip grader={g} />
              </Box>
            ))}
          </Box>

          {!data.hasData || !latest ? (
            <Typography color="text.secondary">No eval-v2 snapshots yet.</Typography>
          ) : (
            <>
              <Typography variant="subtitle2">
                {latest.windowStartDate === latest.windowEndDate
                  ? latest.windowEndDate
                  : `${latest.windowStartDate} – ${latest.windowEndDate}`}
                : {latest.sessions} sampled sessions
                {latest.coverage.length > 0 &&
                  ` (${latest.coverage.map((c) => `${c.date}: ${c.scored} of ${c.frameSize}`).join(", ")})`}
              </Typography>

              <TableContainer component={Paper}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Surface</TableCell>
                      <TableCell>Task type</TableCell>
                      <TableCell>Model</TableCell>
                      <TableCell align="right">Sessions</TableCell>
                      {graders.map((g) => (
                        <TableCell key={g.id}>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                            {GRADER_LABELS[g.id] ?? g.id}
                            <ValidationChip grader={g} />
                          </Box>
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {latest.groups.map((group, i) => (
                      <TableRow key={`${group.surface}|${group.taskType}|${group.model}`} data-testid={`eval-v2-row-${i}`}>
                        <TableCell>{group.surface}</TableCell>
                        <TableCell>{group.taskType}</TableCell>
                        <TableCell>{group.model}</TableCell>
                        <TableCell align="right">{group.sessions}</TableCell>
                        {graders.map((g) => (
                          <TableCell key={g.id}>
                            <MetricCell metric={metricOf(group, g.id)} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              <Typography variant="subtitle2">Trend (all sessions, {data.windowLabel} window)</Typography>
              <TableContainer component={Paper}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Date</TableCell>
                      <TableCell align="right">Sessions</TableCell>
                      {graders.map((g) => (
                        <TableCell key={g.id}>{GRADER_LABELS[g.id] ?? g.id}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {[...data.snapshots].reverse().map((snap) => {
                      const all = snap.groups[0];
                      return (
                        <TableRow key={snap.date} data-testid={`eval-v2-trend-${snap.date}`}>
                          <TableCell>{snap.date}</TableCell>
                          <TableCell align="right">{snap.sessions}</TableCell>
                          {graders.map((g) => (
                            <TableCell key={g.id}>
                              <MetricCell metric={all ? metricOf(all, g.id) : undefined} />
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
        </>
      )}
    </Box>
  );
}
