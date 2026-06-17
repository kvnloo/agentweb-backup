import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { buildApiUrl, CUSTOMER_FRONTEND_URL } from '../config';
import { useAuth } from '../contexts/AuthContext';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  LinearProgress,
  MenuItem,
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
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

type RunStatus = 'running' | 'completed' | 'failed' | 'unknown';
type FlagSeverity = 'info' | 'warning' | 'critical';

interface AgentRunFlag {
  code: string;
  severity: FlagSeverity;
  message: string;
  evidence?: string;
}

interface AgentRunDecision {
  ts: string;
  iteration?: number;
  toolNames: string[];
  toolArgKeys?: string;
  toolArgsPreview?: string;
  decisionExplanation?: string;
  explanationSource?: string;
  toolPolicyFlags?: string;
  toolPolicySummary?: string;
}

interface AgentRunOutcome {
  ts: string;
  eventType: 'agent_mode.tool_invoked' | 'agent_mode.tool_succeeded' | 'agent_mode.tool_failed';
  iteration?: number;
  toolName?: string;
  durationMs?: number;
  errorClass?: string;
  errorMessage?: string;
}

interface AgentRunChatContext {
  found: boolean;
  sessionId: string;
  title?: string;
  portalType?: string;
  pageIdentifier?: string;
  sessionType?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount: number;
  firstUserMessage?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  customerPortalUrl?: string;
}

interface AgentRun {
  runId: string;
  sessionId?: string;
  userId?: string;
  llmModel?: string;
  sessionType?: string;
  startedAt?: string;
  completedAt?: string;
  status: RunStatus;
  toolCalls: number;
  failedToolCalls: number;
  durationMs?: number;
  flags: AgentRunFlag[];
  decisions: AgentRunDecision[];
  outcomes: AgentRunOutcome[];
  chat?: AgentRunChatContext;
}

interface AgentRunsResponse {
  runs: AgentRun[];
  count: number;
  scannedEvents: number;
  filters: {
    runId?: string;
    sessionId?: string;
    userId?: string;
    limit: number;
  };
}

const statusConfig: Record<RunStatus, { label: string; color: 'success' | 'warning' | 'error' | 'default' | 'info' }> = {
  completed: { label: 'Completed', color: 'success' },
  running: { label: 'Running', color: 'info' },
  failed: { label: 'Failed', color: 'error' },
  unknown: { label: 'Unknown', color: 'default' },
};

const severityColor: Record<FlagSeverity, 'info' | 'warning' | 'error'> = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(ms?: number): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function shortId(value?: string, head = 12): string {
  if (!value) return '-';
  if (value.length <= head + 6) return value;
  return `${value.slice(0, head)}...${value.slice(-6)}`;
}

function parsePolicySummary(summary?: string): string[] {
  if (!summary) return [];
  return summary.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function runChatLabel(run: AgentRun): string {
  return run.chat?.title || run.chat?.firstUserMessage || run.chat?.lastUserMessage || shortId(run.sessionId, 16);
}

function runChatMeta(run: AgentRun): string {
  const parts = [
    run.chat?.found ? `${run.chat.messageCount} messages` : 'No chat history',
    formatDate(run.startedAt),
  ];
  return parts.filter(Boolean).join(' · ');
}

function buildCustomerChatUrl(chat?: AgentRunChatContext): string | undefined {
  if (!chat?.sessionId) return chat?.customerPortalUrl;
  const baseUrl = CUSTOMER_FRONTEND_URL.replace(/\/+$/, '');
  return `${baseUrl}/agent-mode/${encodeURIComponent(chat.sessionId)}`;
}

export default function AgentRunsInspector() {
  const { token, user } = useAuth();
  const [searchParams] = useSearchParams();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedEvents, setScannedEvents] = useState(0);
  const [filters, setFilters] = useState({
    userId: searchParams.get('userId') ?? '',
    sessionId: searchParams.get('sessionId') ?? '',
    runId: searchParams.get('runId') ?? '',
    limit: 200,
  });

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );

  useEffect(() => {
    if (user?.isAdmin) {
      void fetchRuns();
    }
  }, [user?.isAdmin]);

  const fetchRuns = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(filters.limit));
      if (filters.userId.trim()) params.set('userId', filters.userId.trim());
      if (filters.sessionId.trim()) params.set('sessionId', filters.sessionId.trim());
      if (filters.runId.trim()) params.set('runId', filters.runId.trim());

      const response = await axios.get<AgentRunsResponse>(
        buildApiUrl(`/api/admin/agent-runs?${params.toString()}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const nextRuns = response.data.runs ?? [];
      setRuns(nextRuns);
      setScannedEvents(response.data.scannedEvents ?? 0);
      setSelectedRunId((current) => {
        if (current && nextRuns.some((run) => run.runId === current)) return current;
        return nextRuns[0]?.runId ?? null;
      });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load AgentRun traces.');
    } finally {
      setLoading(false);
    }
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

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 260 }}>
          <Typography variant="h5" fontWeight={700}>
            AgentRun Inspector
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Read-only trace view for Agent Mode decisions, tool calls, failures, and gateway flags.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={() => void fetchRuns()}
          disabled={loading}
        >
          Refresh
        </Button>
      </Box>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} md={3}>
              <TextField
                label="User ID"
                size="small"
                fullWidth
                value={filters.userId}
                onChange={(event) => setFilters((prev) => ({ ...prev, userId: event.target.value }))}
              />
            </Grid>
            <Grid item xs={12} md={3}>
              <TextField
                label="Session ID"
                size="small"
                fullWidth
                value={filters.sessionId}
                onChange={(event) => setFilters((prev) => ({ ...prev, sessionId: event.target.value }))}
              />
            </Grid>
            <Grid item xs={12} md={3}>
              <TextField
                label="Run ID"
                size="small"
                fullWidth
                value={filters.runId}
                onChange={(event) => setFilters((prev) => ({ ...prev, runId: event.target.value }))}
              />
            </Grid>
            <Grid item xs={6} md={1.5}>
              <TextField
                label="Events"
                size="small"
                select
                fullWidth
                value={filters.limit}
                onChange={(event) => setFilters((prev) => ({ ...prev, limit: Number(event.target.value) }))}
              >
                {[120, 200, 350, 500].map((limit) => (
                  <MenuItem key={limit} value={limit}>
                    {limit}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={6} md={1.5}>
              <Button
                fullWidth
                variant="contained"
                startIcon={<SearchIcon />}
                onClick={() => void fetchRuns()}
                disabled={loading}
              >
                Search
              </Button>
            </Grid>
          </Grid>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            Showing {runs.length} run(s) from {scannedEvents} scanned spine event(s).
          </Typography>
        </CardContent>
        {loading && <LinearProgress />}
      </Card>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12} lg={5}>
          <Card>
            <CardContent sx={{ pb: 1 }}>
              <Typography variant="subtitle1" fontWeight={700}>
                Recent Runs
              </Typography>
            </CardContent>
            <TableContainer sx={{ maxHeight: 620 }}>
              <Table stickyHeader size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Chat</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Tools</TableCell>
                    <TableCell align="right">Flags</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow
                      key={run.runId}
                      hover
                      selected={selectedRun?.runId === run.runId}
                      onClick={() => setSelectedRunId(run.runId)}
                      sx={{ cursor: 'pointer' }}
                    >
                      <TableCell>
                        <Tooltip title={run.chat?.firstUserMessage || run.runId}>
                          <Typography variant="body2" fontWeight={600} sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {runChatLabel(run)}
                          </Typography>
                        </Tooltip>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {runChatMeta(run)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          Run {shortId(run.runId, 10)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip size="small" label={statusConfig[run.status].label} color={statusConfig[run.status].color} />
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2">{run.toolCalls}</Typography>
                        {run.failedToolCalls > 0 && (
                          <Typography variant="caption" color="error.main">
                            {run.failedToolCalls} failed
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Chip
                          size="small"
                          label={run.flags.length}
                          color={run.flags.some((flag) => flag.severity === 'critical') ? 'error' : run.flags.length ? 'warning' : 'default'}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {!runs.length && !loading && (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                          No AgentRun traces found for these filters.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </Grid>

        <Grid item xs={12} lg={7}>
          <RunDetail run={selectedRun} />
        </Grid>
      </Grid>
    </Box>
  );
}

function RunDetail({ run }: { run: AgentRun | null }) {
  if (!run) {
    return (
      <Card>
        <CardContent>
          <Typography color="text.secondary">Select a run to inspect its trace.</Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Stack spacing={3}>
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Box sx={{ flex: 1, minWidth: 260 }}>
              <Tooltip title={run.runId}>
                <Typography variant="h6" fontWeight={700}>
                  {runChatLabel(run)}
                </Typography>
              </Tooltip>
              <Typography variant="body2" color="text.secondary">
                User {shortId(run.userId, 18)} · Session {shortId(run.sessionId, 18)}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Run {shortId(run.runId, 24)}
              </Typography>
            </Box>
            <Chip label={statusConfig[run.status].label} color={statusConfig[run.status].color} />
          </Box>

          <Divider sx={{ my: 2 }} />

          <Grid container spacing={2}>
            <Metric label="Started" value={formatDate(run.startedAt)} />
            <Metric label="Duration" value={formatDuration(run.durationMs)} />
            <Metric label="Model" value={run.llmModel || '-'} />
            <Metric label="Tools" value={`${run.toolCalls} total / ${run.failedToolCalls} failed`} />
          </Grid>
        </CardContent>
      </Card>

      <ChatHistorySummary run={run} />

      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <WarningAmberIcon fontSize="small" color={run.flags.length ? 'warning' : 'disabled'} />
            <Typography variant="subtitle1" fontWeight={700}>
              Flags
            </Typography>
          </Box>
          {run.flags.length ? (
            <Stack spacing={1}>
              {run.flags.map((flag) => (
                <Alert key={`${flag.code}:${flag.evidence ?? ''}`} severity={severityColor[flag.severity]} icon={false}>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip size="small" label={flag.code} color={severityColor[flag.severity]} />
                    <Typography variant="body2">{flag.message}</Typography>
                    {flag.evidence && (
                      <Typography variant="caption" color="text.secondary">
                        Evidence: {flag.evidence}
                      </Typography>
                    )}
                  </Box>
                </Alert>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No warning or critical flags on this run.
            </Typography>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2 }}>
            Decisions
          </Typography>
          <Stack spacing={1.5}>
            {run.decisions.map((decision, index) => (
              <Box key={`${decision.ts}:${index}`} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="body2" fontWeight={700}>
                    Iteration {decision.iteration ?? index + 1}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatDate(decision.ts)}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 1 }}>
                  {decision.toolNames.map((toolName) => (
                    <Chip key={toolName} size="small" label={toolName} variant="outlined" />
                  ))}
                </Box>
                {decision.decisionExplanation && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {decision.decisionExplanation}
                  </Typography>
                )}
                {parsePolicySummary(decision.toolPolicySummary).length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      Tool Gateway policy
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.5 }}>
                      {parsePolicySummary(decision.toolPolicySummary).map((policy) => (
                        <Chip key={policy} size="small" label={policy} />
                      ))}
                    </Box>
                  </Box>
                )}
              </Box>
            ))}
            {!run.decisions.length && (
              <Typography variant="body2" color="text.secondary">
                No decision events were recorded for this run.
              </Typography>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2 }}>
            Tool Timeline
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time</TableCell>
                  <TableCell>Event</TableCell>
                  <TableCell>Tool</TableCell>
                  <TableCell align="right">Duration</TableCell>
                  <TableCell>Error</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {run.outcomes.map((outcome, index) => (
                  <TableRow key={`${outcome.ts}:${outcome.eventType}:${index}`}>
                    <TableCell>{formatDate(outcome.ts)}</TableCell>
                    <TableCell>
                      <TimelineChip eventType={outcome.eventType} />
                    </TableCell>
                    <TableCell>{outcome.toolName || '-'}</TableCell>
                    <TableCell align="right">{formatDuration(outcome.durationMs)}</TableCell>
                    <TableCell>
                      {outcome.errorMessage ? (
                        <Tooltip title={outcome.errorMessage}>
                          <Typography variant="body2" color="error.main">
                            {outcome.errorClass || 'Error'}
                          </Typography>
                        </Tooltip>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {!run.outcomes.length && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                        No tool events recorded.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Stack>
  );
}

function ChatHistorySummary({ run }: { run: AgentRun }) {
  const chat = run.chat;
  const customerChatUrl = buildCustomerChatUrl(chat);
  return (
    <Card>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap', mb: 2 }}>
          <Box sx={{ flex: 1, minWidth: 260 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              Chat History
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {chat?.found
                ? `${chat.messageCount} message(s) linked to this AgentRun session.`
                : 'No chat history found for this AgentRun session.'}
            </Typography>
          </Box>
          {customerChatUrl && (
            <Button
              component="a"
              href={customerChatUrl}
              target="_blank"
              rel="noreferrer"
              size="small"
              variant="outlined"
              endIcon={<OpenInNewIcon fontSize="small" />}
            >
              Open chat
            </Button>
          )}
        </Box>

        {chat?.found ? (
          <Grid container spacing={2}>
            <Metric label="Session title" value={chat.title || '-'} />
            <Metric label="Updated" value={formatDate(chat.updatedAt)} />
            <Metric label="First user ask" value={chat.firstUserMessage || '-'} />
            <Metric label="Latest user ask" value={chat.lastUserMessage || '-'} />
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary">
                Latest assistant response
              </Typography>
              <Typography variant="body2" fontWeight={600} sx={{ wordBreak: 'break-word' }}>
                {chat.lastAssistantMessage || '-'}
              </Typography>
            </Grid>
          </Grid>
        ) : (
          <Typography variant="body2" color="text.secondary">
            The spine has a session ID, but the inspector could not find matching chat messages. That usually means the run came from an older trace, another environment, or a deleted session.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Grid item xs={12} sm={6}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={600} sx={{ wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Grid>
  );
}

function TimelineChip({ eventType }: { eventType: AgentRunOutcome['eventType'] }) {
  if (eventType.endsWith('tool_failed')) {
    return <Chip size="small" icon={<ErrorOutlineIcon />} label="Failed" color="error" />;
  }
  if (eventType.endsWith('tool_succeeded')) {
    return <Chip size="small" icon={<CheckCircleIcon />} label="Succeeded" color="success" />;
  }
  return <Chip size="small" label="Invoked" variant="outlined" />;
}
