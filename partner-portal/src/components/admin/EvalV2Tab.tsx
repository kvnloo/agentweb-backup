import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { hasMoreToScrollRight } from "./evalV2ScrollUtils";

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

/** Cost and latency per successful task (ENG-2196). */
interface EvalV2Efficiency {
  graded: number;
  successes: number;
  withSpend: number;
  successesWithSpend: number;
  spendNone: number;
  spendUnknown: number;
  costPerSuccessUsd: number | null;
  medianSuccessCostUsd: number | null;
  successesWithLatency: number;
  latencyPerSuccessP50Ms: number | null;
  latencyPerSuccessP95Ms: number | null;
}

interface EvalV2Group {
  surface: string;
  taskType: string;
  model: string;
  sessions: number;
  metrics: EvalV2Metric[];
  /** Absent on snapshots written before ENG-2196. */
  efficiency?: EvalV2Efficiency;
}

interface RateWithCI {
  n: number;
  passes: number;
  rate: number | null;
  ci: Interval | null;
}

type SurfaceReadStatus = "ok" | "truncated" | "unavailable";

/** Mirrors backend/src/loops/eval/evalV2Surfaces.ts (ENG-2196). */
interface CreativeSnapshot {
  date: string;
  windowStartDate: string;
  windowEndDate: string;
  status: SurfaceReadStatus;
  statusReason?: string;
  creatives: number;
  gates: RateWithCI & { versions: string[]; failedChecks: Record<string, number>; mayGate: boolean };
  rubric: {
    versions: string[];
    judged: number;
    errors: number;
    skipped: number;
    passedCountDistribution: number[];
    floorMet: RateWithCI;
    mayGate: boolean;
  };
}

interface AccountHealthSnapshot {
  date: string;
  windowStartDate: string;
  windowEndDate: string;
  status: SurfaceReadStatus;
  statusReason?: string;
  accounts: number;
  byState: Record<string, number>;
  flips: RateWithCI;
  mayGate: boolean;
}

interface RegistryGrader {
  id: string;
  surface: string;
  graderType: string;
  measures: string;
  version: string;
  modelFamily: string;
  mayGate: boolean;
}

interface EvalV2Snapshot {
  date: string;
  windowLabel: "1d" | "7d";
  windowStartDate: string;
  windowEndDate: string;
  sessions: number;
  coverage: Array<{ date: string; frameSize: number; sampleSize: number; scored: number }>;
  groups: EvalV2Group[];
  spendAttribution?: { sessions: number; attributed: number; none: number; truncated: number; notRead: number };
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
  /** ENG-2196; absent from a backend that predates it. */
  creative?: CreativeSnapshot[];
  accountHealth?: AccountHealthSnapshot[];
  registry?: RegistryGrader[];
}

const GRADER_LABELS: Readonly<Record<string, string>> = {
  "agent-task-success": "Task success",
  "agent-tool-correctness": "Tool correctness",
  "agent-groundedness-offline": "Groundedness",
  "agent-reply-length-adherence": "Requested length",
  "agent-format-adherence": "Requested format",
  "agent-act-without-asking": "Acts when told",
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const duration = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Below this sample size a rate can swing sharply with the next session graded (ENG-2221):
 * a row's n is flagged with a badge rather than by dimming its text, which would fight WCAG
 * contrast exactly where accuracy matters most.
 */
const LOW_SAMPLE_THRESHOLD = 10;

function LowSampleBadge() {
  return (
    <Tooltip title={`Fewer than ${LOW_SAMPLE_THRESHOLD} sampled sessions: this rate can swing sharply with the next session graded.`}>
      <Chip
        label="low n"
        size="small"
        variant="outlined"
        data-testid="eval-v2-low-n-badge"
        sx={{ height: 18, fontSize: "0.65rem", "& .MuiChip-label": { px: 0.75 } }}
      />
    </Tooltip>
  );
}

function MetricCell({ metric }: { metric: (RateWithCI & { notApplicable?: number }) | undefined }) {
  if (!metric || metric.rate === null || !metric.ci) {
    return <Typography variant="body2" color="text.secondary">– (n=0)</Typography>;
  }
  const notApplicable = metric.notApplicable === undefined ? "" : `; ${metric.notApplicable} not applicable`;
  return (
    <Tooltip title={`${metric.passes} of ${metric.n} passed${notApplicable}. 95% Wilson interval.`}>
      <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
        <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
          {pct(metric.rate)}
        </Typography>{" "}
        <Typography variant="caption" component="span" color="text.secondary">
          [{pct(metric.ci.low)}–{pct(metric.ci.high)}] n={metric.n}
        </Typography>
        {metric.n < LOW_SAMPLE_THRESHOLD && <LowSampleBadge />}
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

/** Spend of labelled sessions with spend data per success (failures charged to successes). */
function CostCell({ efficiency }: { efficiency: EvalV2Efficiency | undefined }) {
  if (!efficiency || efficiency.costPerSuccessUsd === null) {
    return <Typography variant="body2" color="text.secondary">– (no spend)</Typography>;
  }
  return (
    <Tooltip
      title={`Spend of ${efficiency.withSpend} labelled sessions with spend, divided by their ${efficiency.successesWithSpend} successes. ` +
        `${efficiency.spendNone} had no spend row with their session id; ${efficiency.spendUnknown} could not be read.`}
    >
      <Box component="span">
        <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
          {usd(efficiency.costPerSuccessUsd)}
        </Typography>{" "}
        <Typography variant="caption" component="span" color="text.secondary">
          n={efficiency.successesWithSpend} of {efficiency.successes}
        </Typography>
      </Box>
    </Tooltip>
  );
}

/** Wall time of a successful session's runs, p50 (p95 in the caption). */
function LatencyCell({ efficiency }: { efficiency: EvalV2Efficiency | undefined }) {
  if (!efficiency || efficiency.latencyPerSuccessP50Ms === null) {
    return <Typography variant="body2" color="text.secondary">– (no run time)</Typography>;
  }
  return (
    <Box component="span">
      <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>
        {duration(efficiency.latencyPerSuccessP50Ms)}
      </Typography>{" "}
      <Typography variant="caption" component="span" color="text.secondary">
        p95 {duration(efficiency.latencyPerSuccessP95Ms ?? efficiency.latencyPerSuccessP50Ms)} n={efficiency.successesWithLatency}
      </Typography>
    </Box>
  );
}

const windowText = (s: { windowStartDate: string; windowEndDate: string }) =>
  s.windowStartDate === s.windowEndDate ? s.windowEndDate : `${s.windowStartDate} – ${s.windowEndDate}`;

/** Sticks the first (identifying) column of a wide table to the left while it scrolls horizontally (ENG-2221). */
const stickyColumnSx = {
  position: "sticky" as const,
  left: 0,
  zIndex: 2,
  backgroundColor: "background.paper",
  borderRight: 1,
  borderColor: "divider",
};

/**
 * Wraps a wide table so its first column stays visible (via `stickyColumnSx` on that column's
 * cells) and shows a fading shadow on the right edge only while there is more to scroll to
 * (ENG-2221) — the native scrollbar alone was too thin a hint that the newest criteria columns
 * existed.
 */
function ScrollableWideTable({ testId, children }: { testId: string; children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showShadow, setShowShadow] = useState(false);

  const updateShadow = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setShowShadow(hasMoreToScrollRight({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: el.scrollLeft }));
  }, []);

  useEffect(() => {
    updateShadow();
    window.addEventListener("resize", updateShadow);
    return () => window.removeEventListener("resize", updateShadow);
  }, [updateShadow]);

  return (
    <Box sx={{ position: "relative" }}>
      <TableContainer component={Paper} ref={containerRef} onScroll={updateShadow} data-testid={testId}>
        {children}
      </TableContainer>
      {showShadow && (
        <Box
          data-testid={`${testId}-shadow`}
          aria-hidden
          sx={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 24,
            pointerEvents: "none",
            background: (theme) =>
              `linear-gradient(to right, transparent, ${theme.palette.mode === "dark" ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.2)"})`,
          }}
        />
      )}
    </Box>
  );
}

function SurfaceStatus({ status, reason }: { status: SurfaceReadStatus; reason?: string }) {
  if (status === "ok") return null;
  return (
    <Alert severity="warning">
      {status === "truncated" ? "Read stopped at its bound; no numbers are shown" : "Read failed; no numbers are shown"}
      {reason ? `: ${reason}` : "."}
    </Alert>
  );
}

/** Creative gates and rubric judge, from the results stored on human-eval candidates (ENG-2196). */
function CreativeSection({ snapshots }: { snapshots: CreativeSnapshot[] }) {
  const latest = snapshots[snapshots.length - 1];
  return (
    <Box id="eval-v2-section-creative" data-testid="eval-v2-creative" sx={{ ...sectionAnchorSx, display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography variant="subtitle1">Creatives</Typography>
      {!latest ? (
        <Typography color="text.secondary">No creative snapshots yet.</Typography>
      ) : (
        <>
          <Typography variant="subtitle2">
            {windowText(latest)}: {latest.creatives} creatives with a gate or rubric result
          </Typography>
          <SurfaceStatus status={latest.status} reason={latest.statusReason} />
          {latest.status === "ok" && (
            <TableContainer component={Paper}>
              <Table size="small">
                <TableBody>
                  <TableRow data-testid="eval-v2-creative-gates">
                    <TableCell>Deterministic gates pass rate</TableCell>
                    <TableCell>
                      <MetricCell metric={latest.gates} />
                    </TableCell>
                    <TableCell>
                      {Object.entries(latest.gates.failedChecks).length === 0
                        ? "no failing checks"
                        : `failing: ${Object.entries(latest.gates.failedChecks).map(([id, n]) => `${id} ${n}`).join(", ")}`}
                    </TableCell>
                  </TableRow>
                  <TableRow data-testid="eval-v2-creative-rubric">
                    <TableCell>Rubric: criteria passed (0–7)</TableCell>
                    <TableCell>
                      {latest.rubric.judged === 0
                        ? "– (n=0)"
                        : latest.rubric.passedCountDistribution.map((count, k) => `${k}:${count}`).join(" ")}
                    </TableCell>
                    <TableCell>
                      floor met <MetricCell metric={latest.rubric.floorMet} />; {latest.rubric.errors} errors, {latest.rubric.skipped} skipped
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}
    </Box>
  );
}

/** The account-health classifier's current state per paying account (ENG-2196). */
function AccountHealthSection({ snapshots }: { snapshots: AccountHealthSnapshot[] }) {
  const latest = snapshots[snapshots.length - 1];
  return (
    <Box id="eval-v2-section-account-health" data-testid="eval-v2-account-health" sx={{ ...sectionAnchorSx, display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography variant="subtitle1">Account health</Typography>
      {!latest ? (
        <Typography color="text.secondary">No account-health snapshots yet.</Typography>
      ) : (
        <>
          <Typography variant="subtitle2">
            {windowText(latest)}: {latest.accounts} classified accounts
          </Typography>
          <SurfaceStatus status={latest.status} reason={latest.statusReason} />
          {latest.status === "ok" && (
            <Typography variant="body2" component="div">
              {Object.entries(latest.byState).filter(([, n]) => n > 0).map(([state, n]) => `${state} ${n}`).join(", ") || "no accounts"}
              {"; state changes in the window: "}
              <MetricCell metric={latest.flips} />
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

/** Every grader in the eval registry with its version and validation state (ENG-2196). */
function RegistryTable({ registry }: { registry: RegistryGrader[] }) {
  return (
    <TableContainer component={Paper} data-testid="eval-v2-registry">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Grader</TableCell>
            <TableCell>Surface</TableCell>
            <TableCell>Type</TableCell>
            <TableCell>Version</TableCell>
            <TableCell>Validated</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {registry.map((g) => (
            <TableRow key={g.id} data-testid={`eval-v2-registry-${g.id}`}>
              <TableCell>
                <Tooltip title={g.measures}>
                  <span>{g.id}</span>
                </Tooltip>
              </TableCell>
              <TableCell>{g.surface}</TableCell>
              <TableCell>{g.graderType}</TableCell>
              <TableCell>{g.version}</TableCell>
              <TableCell>{g.mayGate ? "yes" : "no"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * Jump targets for {@link SectionNav} (ENG-2221): every section stays fully visible, none collapsed.
 * Creative and Account health always render their anchor Box (a "no data" message inside it when
 * empty), so they're always valid targets. Main table/Trend and Grader registry only render their
 * anchor at all when there's data — {@link SectionNav} must be told when to skip those.
 */
const SECTION_NAV_ITEMS = [
  { id: "eval-v2-section-main-table", label: "Main table", key: "mainTable" as const },
  { id: "eval-v2-section-trend", label: "Trend", key: "mainTable" as const },
  { id: "eval-v2-section-creative", label: "Creative", key: "always" as const },
  { id: "eval-v2-section-account-health", label: "Account health", key: "always" as const },
  { id: "eval-v2-section-registry", label: "Grader registry", key: "registry" as const },
] as const;

interface SectionNavProps {
  /** Whether `eval-v2-section-main-table` and `eval-v2-section-trend` actually exist. */
  hasMainTable: boolean;
  /** Whether `eval-v2-section-registry` actually exists. */
  hasRegistry: boolean;
}

/** Sticky in-page nav (ENG-2221): a ~3500px page with no anchors was awkward for a 30-second daily glance. */
function SectionNav({ hasMainTable, hasRegistry }: SectionNavProps) {
  const available = { always: true, mainTable: hasMainTable, registry: hasRegistry };
  const items = SECTION_NAV_ITEMS.filter((item) => available[item.key]);
  return (
    <Box
      component="nav"
      aria-label="Eval v2 sections"
      data-testid="eval-v2-section-nav"
      sx={{
        position: "sticky",
        top: 0,
        zIndex: (theme) => theme.zIndex.appBar,
        bgcolor: "background.paper",
        borderBottom: 1,
        borderColor: "divider",
        display: "flex",
        flexWrap: "wrap",
        gap: 2,
        py: 1,
      }}
    >
      {items.map((item) => (
        <Box
          key={item.id}
          component="a"
          href={`#${item.id}`}
          sx={{
            typography: "body2",
            color: "text.primary",
            textDecoration: "none",
            "&:hover": { textDecoration: "underline" },
          }}
        >
          {item.label}
        </Box>
      ))}
    </Box>
  );
}

/** Lands an anchor jump below the sticky {@link SectionNav} instead of under it. */
const sectionAnchorSx = { scrollMarginTop: 48 };

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
          <SectionNav hasMainTable={data.hasData && !!latest} hasRegistry={!!data.registry && data.registry.length > 0} />
          {unvalidated.length > 0 && (
            <Alert severity="warning" data-testid="eval-v2-unvalidated-banner">
              {unvalidated.length === graders.length ? "All graders are" : `${unvalidated.length} graders are`} unvalidated:
              no grader has been checked against human labels yet, so these rates are for inspection only and drive no
              alert (ENG-2128 principle 2).
            </Alert>
          )}
          <Alert severity="info" data-testid="eval-v2-satisfaction-note">
            The legacy per-session Satisfaction score is an unvalidated LLM-judge score. It is not part of these
            results and is hidden in Chat History unless an admin opens it there.
          </Alert>
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
              <Box id="eval-v2-section-main-table" sx={sectionAnchorSx}>
                <Typography variant="subtitle2">
                  {latest.windowStartDate === latest.windowEndDate
                    ? latest.windowEndDate
                    : `${latest.windowStartDate} – ${latest.windowEndDate}`}
                  : {latest.sessions} sampled sessions
                  {latest.coverage.length > 0 &&
                    ` (${latest.coverage.map((c) => `${c.date}: ${c.scored} of ${c.frameSize}`).join(", ")})`}
                </Typography>
                {latest.spendAttribution && (
                  <Typography variant="body2" color="text.secondary" data-testid="eval-v2-spend-attribution">
                    Spend tied to the session for {latest.spendAttribution.attributed} of {latest.spendAttribution.sessions} sampled
                    sessions ({latest.spendAttribution.none} with no spend row carrying their id,{" "}
                    {latest.spendAttribution.truncated + latest.spendAttribution.notRead} not read). Cost per success covers only
                    sessions with spend.
                  </Typography>
                )}

                <ScrollableWideTable testId="eval-v2-breakdown-table">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={stickyColumnSx}>Surface</TableCell>
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
                        <TableCell>Cost / success</TableCell>
                        <TableCell>Run time / success</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {latest.groups.map((group, i) => (
                        <TableRow key={`${group.surface}|${group.taskType}|${group.model}`} data-testid={`eval-v2-row-${i}`}>
                          <TableCell sx={stickyColumnSx}>{group.surface}</TableCell>
                          <TableCell>{group.taskType}</TableCell>
                          <TableCell>{group.model}</TableCell>
                          <TableCell align="right">{group.sessions}</TableCell>
                          {graders.map((g) => (
                            <TableCell key={g.id}>
                              <MetricCell metric={metricOf(group, g.id)} />
                            </TableCell>
                          ))}
                          <TableCell>
                            <CostCell efficiency={group.efficiency} />
                          </TableCell>
                          <TableCell>
                            <LatencyCell efficiency={group.efficiency} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollableWideTable>
              </Box>

              <Box id="eval-v2-section-trend" sx={sectionAnchorSx}>
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
              </Box>
            </>
          )}

          <CreativeSection snapshots={data.creative ?? []} />
          <AccountHealthSection snapshots={data.accountHealth ?? []} />
          {data.registry && data.registry.length > 0 && (
            <Box id="eval-v2-section-registry" sx={sectionAnchorSx}>
              <Typography variant="subtitle1">Grader registry</Typography>
              <RegistryTable registry={data.registry} />
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
