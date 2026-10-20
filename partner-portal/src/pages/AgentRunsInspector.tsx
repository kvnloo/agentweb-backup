import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { buildApiUrl, CUSTOMER_FRONTEND_URL } from '../config';
import { useAuth } from '../contexts/AuthContext';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  LinearProgress,
  List,
  ListItemButton,
  MenuItem,
  Skeleton,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import BugReportIcon from '@mui/icons-material/BugReport';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { AskCard, CopyButton, FinalReplyCard, SectionTitle, WorkPlanTrace } from '../components/agentRuns/RunTrace';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatShortDateTime,
  formatTime,
  formatTokens,
  shortId,
} from '../components/agentRuns/agentRunFormat';
import type { AgentRun, AgentRunFlag, AgentRunsResponse, AgentRunTrace } from '../components/agentRuns/types';

const MONO = '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace';
const RUN_LIMITS = [25, 50, 100, 200];
const DEFAULT_RUN_LIMIT = 50;

/** Flags whose content the header already shows as stats or the verdict line. */
const FLAGS_SHOWN_AS_STATS = new Set(['degraded_run', 'run_failed', 'failed_tool_calls', 'long_run', 'high_tool_volume']);

type StatusTone = 'ok' | 'warning' | 'error' | 'neutral';

/**
 * The run's status in words. `recovered` (known once the trace has loaded) separates "failed calls
 * the agent recovered from" — a pass under the task-success rubric — from failures left standing.
 */
function statusOf(run: AgentRun, recovered?: number): { label: string; tone: StatusTone } {
  const failed = run.failedToolCalls;
  const plural = failed === 1 ? '' : 's';
  if (run.status === 'failed' || run.outcomeVerdict === 'failed') return { label: 'Failed', tone: 'error' };
  if (run.status === 'running') return { label: 'Running', tone: 'neutral' };
  if (run.status === 'unknown') return { label: 'Unknown', tone: 'neutral' };
  if (failed > 0 && recovered != null && recovered >= failed) return { label: `Completed · ${failed} failure${plural}, all recovered`, tone: 'ok' };
  if (failed > 0 || run.outcomeVerdict === 'degraded') {
    return { label: failed ? `Completed · ${failed} failed call${plural}` : 'Completed · degraded', tone: 'warning' };
  }
  return { label: 'Completed', tone: 'ok' };
}

const TONE_STYLE: Record<StatusTone, { border: string; icon: React.ReactElement | undefined }> = {
  ok: { border: 'success.main', icon: <CheckCircleIcon sx={{ color: 'success.main' }} /> },
  warning: { border: 'warning.dark', icon: <WarningAmberIcon sx={{ color: 'warning.dark' }} /> },
  error: { border: 'error.main', icon: <ErrorOutlineIcon sx={{ color: 'error.dark' }} /> },
  neutral: { border: 'divider', icon: undefined },
};

function StatusChip({ run, recovered, size = 'medium' }: { run: AgentRun; recovered?: number; size?: 'small' | 'medium' }) {
  const s = statusOf(run, recovered);
  const reasons = run.outcomeReasons ? `Verdict: ${run.outcomeVerdict ?? 'unknown'} (${run.outcomeReasons.replace(/_/g, ' ')})` : '';
  return (
    <Tooltip title={reasons}>
      <Chip
        size={size}
        variant="outlined"
        label={s.label}
        icon={TONE_STYLE[s.tone].icon}
        sx={{ color: 'text.primary', borderColor: TONE_STYLE[s.tone].border, '& .MuiChip-icon': { ml: '6px' } }}
      />
    </Tooltip>
  );
}

function runTitle(run: AgentRun): string {
  return run.chat?.title || run.chat?.firstUserMessage || `Session ${shortId(run.sessionId, 12)}`;
}

function buildCustomerChatUrl(run: AgentRun): string | undefined {
  if (!run.sessionId) return run.chat?.customerPortalUrl;
  return `${CUSTOMER_FRONTEND_URL.replace(/\/+$/, '')}/agent-mode/${encodeURIComponent(run.sessionId)}`;
}

/** Flags grouped by code, so five side_effecting_tool flags are one chip "×5" listing the tools. */
function groupFlags(flags: AgentRunFlag[]): Array<{ code: string; severity: AgentRunFlag['severity']; count: number; detail: string[] }> {
  const groups = new Map<string, { code: string; severity: AgentRunFlag['severity']; count: number; detail: string[] }>();
  for (const flag of flags) {
    if (FLAGS_SHOWN_AS_STATS.has(flag.code)) continue;
    const group = groups.get(flag.code) ?? { code: flag.code, severity: flag.severity, count: 0, detail: [] };
    group.count += 1;
    group.detail.push(flag.evidence ?? flag.message);
    if (flag.severity === 'critical') group.severity = 'critical';
    groups.set(flag.code, group);
  }
  return [...groups.values()].sort((a, b) => (a.severity === 'critical' ? -1 : 0) - (b.severity === 'critical' ? -1 : 0));
}

function readFilters(params: URLSearchParams) {
  const limit = Number(params.get('limit'));
  return {
    sessionId: params.get('sessionId') ?? '',
    runId: params.get('runId') ?? '',
    userId: params.get('userId') ?? '',
    limit: RUN_LIMITS.includes(limit) ? limit : DEFAULT_RUN_LIMIT,
  };
}

export default function AgentRunsInspector() {
  const { token, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionParam = searchParams.get('sessionId') ?? '';
  const runIdParam = searchParams.get('runId') ?? '';
  const userIdParam = searchParams.get('userId') ?? '';
  const limitParam = searchParams.get('limit') ?? '';
  // Keyed on the filter values, not on searchParams: selecting a run (?run=) must not re-run the search.
  const applied = useMemo(
    () => readFilters(new URLSearchParams({ sessionId: sessionParam, runId: runIdParam, userId: userIdParam, limit: limitParam })),
    [sessionParam, runIdParam, userIdParam, limitParam]
  );
  const [draft, setDraft] = useState(applied);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => setDraft(applied), [applied]);

  useEffect(() => {
    if (!user?.isAdmin) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set('limit', String(applied.limit));
        if (applied.userId.trim()) params.set('userId', applied.userId.trim());
        if (applied.sessionId.trim()) params.set('sessionId', applied.sessionId.trim());
        if (applied.runId.trim()) params.set('runId', applied.runId.trim());
        const response = await axios.get<AgentRunsResponse>(buildApiUrl(`/api/admin/agent-runs?${params.toString()}`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        setRuns(response.data.runs ?? []);
        setTruncated(Boolean(response.data.truncated));
      } catch (err) {
        if (cancelled) return;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        setError(
          status === 401 || status === 403
            ? 'Your session cannot read AgentRun traces. Sign in again with an admin account.'
            : 'Could not load AgentRun traces. Try again, or narrow the search to one session.'
        );
        setRuns([]);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [applied, token, user?.isAdmin, refreshKey]);

  const selectedRunId = searchParams.get('run');
  const selectedRun = useMemo(() => runs.find((r) => r.runId === selectedRunId) ?? runs[0] ?? null, [runs, selectedRunId]);

  const selectRun = useCallback(
    (runId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('run', runId);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    if (draft.sessionId.trim()) next.set('sessionId', draft.sessionId.trim());
    if (draft.runId.trim()) next.set('runId', draft.runId.trim());
    if (draft.userId.trim()) next.set('userId', draft.userId.trim());
    if (draft.limit !== DEFAULT_RUN_LIMIT) next.set('limit', String(draft.limit));
    const current = new URLSearchParams(searchParams);
    current.delete('run');
    if (next.toString() === current.toString()) setRefreshKey((k) => k + 1);
    else setSearchParams(next);
  };

  if (!user?.isAdmin) {
    return (
      <Box sx={{ textAlign: 'center', py: 10 }}>
        <BugReportIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
        <Typography variant="h5" sx={{ mt: 2 }}>
          Admin Access Required
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          AgentRun traces are only available to admin users.
        </Typography>
      </Box>
    );
  }

  const showList = runs.length > 1;

  return (
    <Box sx={{ pb: 10 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 240 }}>
          <Typography variant="h5">AgentRun Inspector</Typography>
          <Typography variant="body2" color="text.secondary">
            What the agent was asked, the steps it took, every tool call and its result, and what it replied.
          </Typography>
        </Box>
      </Box>

      <Card variant="outlined" sx={{ mb: 2 }}>
        <Box component="form" onSubmit={submitSearch} role="search" aria-label="Find AgentRuns" sx={{ p: 1.5 }}>
          <Grid container spacing={1.5} alignItems="center">
            <Grid item xs={12} md={4}>
              <TextField
                label="Session ID"
                size="small"
                fullWidth
                value={draft.sessionId}
                onChange={(e) => setDraft((d) => ({ ...d, sessionId: e.target.value }))}
                inputProps={{ style: { fontFamily: MONO, fontSize: 13 } }}
              />
            </Grid>
            <Grid item xs={6} md={2.5}>
              <TextField
                label="Run ID"
                size="small"
                fullWidth
                value={draft.runId}
                onChange={(e) => setDraft((d) => ({ ...d, runId: e.target.value }))}
                inputProps={{ style: { fontFamily: MONO, fontSize: 13 } }}
              />
            </Grid>
            <Grid item xs={6} md={2}>
              <TextField
                label="User ID"
                size="small"
                fullWidth
                value={draft.userId}
                onChange={(e) => setDraft((d) => ({ ...d, userId: e.target.value }))}
                inputProps={{ style: { fontFamily: MONO, fontSize: 13 } }}
              />
            </Grid>
            <Grid item xs={6} md={1.5}>
              <TextField
                label="Max runs"
                size="small"
                select
                fullWidth
                value={draft.limit}
                onChange={(e) => setDraft((d) => ({ ...d, limit: Number(e.target.value) }))}
              >
                {RUN_LIMITS.map((limit) => (
                  <MenuItem key={limit} value={limit}>
                    {limit}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={6} md={2}>
              <Stack direction="row" spacing={1}>
                <Button type="submit" fullWidth variant="contained" startIcon={<SearchIcon />} disabled={loading}>
                  Search
                </Button>
                <Tooltip title="Reload">
                  <span>
                    <Button
                      variant="outlined"
                      color="inherit"
                      aria-label="Reload runs"
                      onClick={() => setRefreshKey((k) => k + 1)}
                      disabled={loading}
                      sx={{ minWidth: 40, px: 1, borderColor: 'divider' }}
                    >
                      <RefreshIcon fontSize="small" />
                    </Button>
                  </span>
                </Tooltip>
              </Stack>
            </Grid>
          </Grid>
        </Box>
        {loading && <LinearProgress />}
      </Card>

      <Box role="status" aria-live="polite" sx={{ mb: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        {!error && truncated && (!runs.length || (!applied.sessionId && !applied.runId)) && (
          <Alert severity="warning">
            Search stopped after scanning the newest 20,000 trace events, so older runs may be missing. Search by a session or
            run ID to find them.
          </Alert>
        )}
        {!error && loaded && !loading && !runs.length && (
          <Alert severity="info">No AgentRuns match this search.</Alert>
        )}
      </Box>

      {!loaded && loading && <DetailSkeleton />}

      {runs.length > 0 && (
        <Grid container spacing={2}>
          {showList && (
            <Grid item xs={12} md={3.5}>
              <RunList runs={runs} selectedRunId={selectedRun?.runId} onSelect={selectRun} />
            </Grid>
          )}
          <Grid item xs={12} md={showList ? 8.5 : 12}>
            {selectedRun && (
              <RunDetail key={selectedRun.runId} run={selectedRun} nextStartedAt={nextRunStart(selectedRun, runs)} token={token} refreshKey={refreshKey} onCopied={setToast} />
            )}
          </Grid>
        </Grid>
      )}

      <Snackbar open={!!toast} autoHideDuration={1800} onClose={() => setToast(null)} message={toast ? `${toast.replace(/^Copy /, '')} copied` : ''} />
    </Box>
  );
}

function RunList({ runs, selectedRunId, onSelect }: { runs: AgentRun[]; selectedRunId?: string; onSelect: (runId: string) => void }) {
  return (
    <Card variant="outlined" sx={{ position: { md: 'sticky' }, top: { md: 88 } }}>
      <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {runs.length} runs
        </Typography>
      </Box>
      <List aria-label="AgentRuns" sx={{ maxHeight: { md: 'calc(100vh - 200px)' }, overflowY: 'auto', py: 0 }}>
        {runs.map((run) => {
          const selected = run.runId === selectedRunId;
          return (
            <ListItemButton
              key={run.runId}
              selected={selected}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(run.runId)}
              sx={{ display: 'block', py: 1.25, borderTop: 1, borderColor: 'divider' }}
            >
              <Typography variant="body2" fontWeight={600} noWrap title={runTitle(run)}>
                {runTitle(run)}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
                <StatusChip run={run} size="small" />
                <Typography variant="caption" color="text.secondary" noWrap title={formatRelative(run.startedAt)}>
                  {formatShortDateTime(run.startedAt)} · {run.toolCalls} calls · {formatDuration(run.durationMs)}
                </Typography>
              </Box>
            </ListItemButton>
          );
        })}
      </List>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <Stack spacing={2} aria-label="Loading">
      <Skeleton variant="rounded" height={140} />
      <Skeleton variant="rounded" height={96} />
      <Skeleton variant="rounded" height={320} />
    </Stack>
  );
}

/** The start of the same session's next run in the results, which bounds this run's messages. */
function nextRunStart(run: AgentRun, runs: AgentRun[]): string | undefined {
  if (!run.startedAt) return undefined;
  return runs
    .filter((r) => r.sessionId === run.sessionId && r.startedAt && r.startedAt > run.startedAt!)
    .map((r) => r.startedAt!)
    .sort()[0];
}

function RunDetail({
  run,
  nextStartedAt,
  token,
  refreshKey,
  onCopied,
}: {
  run: AgentRun;
  nextStartedAt?: string;
  token: string | null;
  refreshKey: number;
  onCopied: (label: string) => void;
}) {
  const [trace, setTrace] = useState<AgentRunTrace | null>(null);
  const [traceLoading, setTraceLoading] = useState(Boolean(run.sessionId));
  const [traceError, setTraceError] = useState<string | null>(null);

  useEffect(() => {
    if (!run.sessionId) return;
    let cancelled = false;
    setTraceLoading(true);
    setTraceError(null);
    const params = new URLSearchParams({ sessionId: run.sessionId });
    if (run.startedAt) params.set('startedAt', run.startedAt);
    if (run.completedAt) params.set('completedAt', run.completedAt);
    if (nextStartedAt) params.set('nextStartedAt', nextStartedAt);
    axios
      .get<{ trace: AgentRunTrace }>(buildApiUrl(`/api/admin/agent-runs/trace?${params.toString()}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => !cancelled && setTrace(res.data.trace))
      .catch(() => !cancelled && setTraceError('Could not load the step-by-step trace for this run.'))
      .finally(() => !cancelled && setTraceLoading(false));
    return () => {
      cancelled = true;
    };
  }, [run.sessionId, run.startedAt, run.completedAt, nextStartedAt, token, refreshKey]);

  return (
    <Stack spacing={2}>
      <RunHeader run={run} trace={trace} onCopied={onCopied} />
      {traceLoading ? (
        <>
          <Skeleton variant="rounded" height={96} />
          <Skeleton variant="rounded" height={320} />
        </>
      ) : (
        <>
          {traceError && <Alert severity="warning">{traceError} The spine summary below is still available.</Alert>}
          <AskCard trace={trace} fallback={run.chat?.firstUserMessage} />
          {trace && <WorkPlanTrace trace={trace} runStartedAt={run.startedAt} onCopied={onCopied} />}
          <FinalReplyCard html={trace?.finalResponse?.html ?? run.chat?.lastAssistantMessage} truncated={trace?.finalResponse?.truncated} onCopied={onCopied} />
        </>
      )}
      <Diagnostics run={run} />
    </Stack>
  );
}

function Stat({ label, value, alert, title }: { label: string; value: React.ReactNode; alert?: string; title?: string }) {
  return (
    <Box sx={{ minWidth: 0 }} title={title}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', whiteSpace: 'nowrap' }}>
        {label}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="body2" fontWeight={600} sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </Typography>
        {alert && (
          <Tooltip title={alert}>
            <WarningAmberIcon titleAccess={alert} tabIndex={0} sx={{ fontSize: 16, color: 'warning.dark' }} />
          </Tooltip>
        )}
      </Box>
    </Box>
  );
}

function IdLine({ label, value, onCopied }: { label: string; value?: string; onCopied: (label: string) => void }) {
  if (!value) return null;
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="caption" sx={{ fontFamily: MONO, ml: 0.5 }} title={value}>
        {shortId(value, 13)}
      </Typography>
      <CopyButton value={value} label={`Copy ${label.toLowerCase()} id`} onCopied={onCopied} />
    </Box>
  );
}

function RunHeader({ run, trace, onCopied }: { run: AgentRun; trace: AgentRunTrace | null; onCopied: (label: string) => void }) {
  const chatUrl = buildCustomerChatUrl(run);
  const steps = trace?.workPlan?.steps ?? [];
  const recovered = trace?.calls.filter((c) => c.status === 'failed' && c.recoveredByCallId).length ?? 0;
  const flagGroups = groupFlags(run.flags);
  const longRun = run.durationMs != null && run.durationMs >= 180_000;
  return (
    <Card variant="outlined">
      <CardContent sx={{ pb: '16px !important' }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Box sx={{ flex: 1, minWidth: 240 }}>
            <Typography variant="h6" sx={{ lineHeight: 1.3, wordBreak: 'break-word' }}>{runTitle(run)}</Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            <StatusChip run={run} recovered={trace ? recovered : undefined} />
            {trace?.finalResponse && (
              <Button
                size="small"
                color="inherit"
                variant="outlined"
                startIcon={<ArrowDownwardIcon fontSize="small" />}
                onClick={() => document.getElementById('final-reply')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
                sx={{ borderColor: 'divider', whiteSpace: 'nowrap' }}
              >
                Final reply
              </Button>
            )}
            {chatUrl && (
              <Button component="a" href={chatUrl} target="_blank" rel="noreferrer" size="small" color="inherit" variant="outlined" endIcon={<OpenInNewIcon fontSize="small" />} sx={{ borderColor: 'divider', whiteSpace: 'nowrap' }}>
                Open chat
              </Button>
            )}
          </Stack>
        </Box>

        <Box
          sx={{
            mt: 2,
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))', lg: 'repeat(7, auto)' },
            justifyContent: { lg: 'space-between' },
          }}
        >
          <Stat label="Started" value={formatTime(run.startedAt)} title={`${formatDateTime(run.startedAt)} · ${formatRelative(run.startedAt) ?? ''}`} />
          <Stat label="Duration" value={formatDuration(run.durationMs)} alert={longRun ? 'Longer than 3 minutes' : undefined} />
          {steps.length > 0 && <Stat label="Steps done" value={`${steps.filter((s) => s.status === 'completed').length} of ${steps.length}`} />}
          <Stat label="Tool calls" value={run.toolCalls} alert={run.toolCalls >= 12 ? '12 or more calls: planning or batching may be loose' : undefined} />
          <Stat
            label="Failed calls"
            value={run.failedToolCalls ? `${run.failedToolCalls}${recovered ? ` (${recovered} recovered)` : ''}` : '0'}
            alert={run.failedToolCalls > recovered ? 'Some failures were not recovered' : undefined}
          />
          {trace?.usage && (
            <Stat
              label="Cost · tokens"
              value={`${formatCost(trace.usage.estimatedCostUsd)} · ${formatTokens(trace.usage.promptTokens + trace.usage.completionTokens)}`}
              title={`${trace.usage.promptTokens.toLocaleString()} prompt + ${trace.usage.completionTokens.toLocaleString()} completion tokens`}
            />
          )}
          <Stat label="Model" value={run.llmModel || '–'} />
        </Box>

        {flagGroups.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 2 }}>
            {flagGroups.map((g) => (
              <Tooltip key={g.code} title={g.detail.join(', ')}>
                <Chip
                  tabIndex={0}
                  size="small"
                  variant={g.severity === 'critical' ? 'filled' : 'outlined'}
                  color={g.severity === 'critical' ? 'error' : 'default'}
                  icon={g.severity === 'critical' ? <ErrorOutlineIcon /> : g.severity === 'warning' ? <WarningAmberIcon /> : undefined}
                  label={`${g.code.replace(/_/g, ' ')}${g.count > 1 ? ` ×${g.count}` : ''}`}
                  sx={g.severity === 'warning' ? { '& .MuiChip-icon': { color: 'warning.dark' } } : undefined}
                />
              </Tooltip>
            ))}
          </Box>
        )}

        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <IdLine label="Run" value={run.runId} onCopied={onCopied} />
          <IdLine label="Session" value={run.sessionId} onCopied={onCopied} />
          <IdLine label="User" value={run.userId} onCopied={onCopied} />
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
            {formatDateTime(run.startedAt)}
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
}

/** Spine-level detail for engineers: gateway policy per tool, repairs, and the raw outcome events. */
function Diagnostics({ run }: { run: AgentRun }) {
  const policies = [...new Set(run.decisions.flatMap((d) => (d.toolPolicySummary ?? '').split(',').map((p) => p.trim()).filter(Boolean)))];
  const repaired = run.decisions.filter((d) => d.argsRepairedCount || d.schemaErrorCount);
  const outcomes = run.outcomes.filter((o) => !o.eventType.endsWith('tool_invoked'));
  return (
    <Accordion variant="outlined" disableGutters sx={{ '&:before': { display: 'none' }, borderRadius: 1 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box>
          <Typography variant="subtitle2" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Diagnostics
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Tool Gateway policy, argument repairs and the raw runtime events
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2.5}>
          <Box>
            <SectionTitle>Tool Gateway policy</SectionTitle>
            {policies.length ? (
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                {policies.map((p) => (
                  <Chip key={p} size="small" label={p} sx={{ fontFamily: MONO, fontSize: 12 }} />
                ))}
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">No policy recorded.</Typography>
            )}
          </Box>

          {repaired.length > 0 && (
            <Box>
              <SectionTitle>Argument repairs and schema rejects</SectionTitle>
              <Stack spacing={0.75}>
                {repaired.map((d, i) => (
                  <Box key={`${d.ts}:${i}`} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 13 }}>{d.toolNames.join(', ')}</Typography>
                    {d.argsRepairedCount ? <Chip size="small" variant="outlined" label={`${d.argsRepairedCount} arg repair(s)`} /> : null}
                    {d.schemaErrorCount ? <Chip size="small" variant="outlined" label={`${d.schemaErrorCount} schema reject(s)`} /> : null}
                  </Box>
                ))}
              </Stack>
            </Box>
          )}

          <Box>
            <SectionTitle>Runtime events</SectionTitle>
            <TableContainer>
              <Table size="small" aria-label="Runtime tool events">
                <TableHead>
                  <TableRow>
                    <TableCell>Time</TableCell>
                    <TableCell>Outcome</TableCell>
                    <TableCell>Tool</TableCell>
                    <TableCell align="right">Duration</TableCell>
                    <TableCell>Failure</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {outcomes.map((o, i) => {
                    const failed = o.eventType.endsWith('tool_failed');
                    const deferred = o.eventType.endsWith('tool_deferred');
                    return (
                      <TableRow key={`${o.ts}:${i}`}>
                        <TableCell sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatTime(o.ts)}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{failed ? 'Failed' : deferred ? 'Deferred' : 'Succeeded'}</TableCell>
                        <TableCell sx={{ fontFamily: MONO, fontSize: 13 }}>{o.toolName || '–'}</TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{formatDuration(o.durationMs)}</TableCell>
                        <TableCell>
                          {o.failureType && <Chip size="small" variant="outlined" label={o.failureType} sx={{ mr: 1 }} />}
                          {o.errorMessage && (
                            <Typography variant="caption" sx={{ wordBreak: 'break-word' }}>
                              {o.errorClass ? `${o.errorClass}: ` : ''}
                              {o.errorMessage}
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!outcomes.length && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <Typography variant="body2" color="text.secondary">No tool events recorded.</Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
