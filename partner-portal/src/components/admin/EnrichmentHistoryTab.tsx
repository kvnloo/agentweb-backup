import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Pie } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip as ChartTooltip, Legend } from 'chart.js';
ChartJS.register(ArcElement, ChartTooltip, Legend);
import {
  Autocomplete,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  FormControl,
  Grid,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  Alert,
} from '@mui/material';
import {
  KeyboardArrowDown as ExpandIcon,
  KeyboardArrowUp as CollapseIcon,
  CheckCircle as CheckIcon,
  Cancel as CancelIcon,
  Storage as CacheIcon,
  CloudDownload as LiveIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

interface SourceCount { live: number; cached: number }
interface SourceBreakdown {
  apollo?: SourceCount;
  unipile?: SourceCount;
  enrichSo?: SourceCount;
  webSearch?: SourceCount;
  sibling?: SourceCount;
  llm?: SourceCount;
}

interface EnrichmentJob {
  jobId: string;
  listId: string;
  listName?: string;
  userId?: string;
  createdAt: string;
  status: 'completed' | 'undone';
  processedCount: number;
  failedCount?: number;
  skippedCount?: number;
  attemptedLeadIds?: string[];
  leadsDeduplicationUnavailable?: boolean;
  skippedLeadIds?: string[];
  skippedDeduplicationUnavailable?: boolean;
  successfulLeadIds?: string[];
  successLeadsDeduplicationUnavailable?: boolean;
  totalFieldsFilled?: number;
  totalFieldsAttempted?: number;
  outputFields?: string[];
  failureBreakdown?: { searchWebFailed: number; linkedinFailed: number; llmOrParseFailed: number; updateFailed: number };
  sourceBreakdown?: SourceBreakdown;
}

interface FieldEnriched { field: string; provider: string; fromCache: boolean }
interface LeadSnapshot { leadId: string; fieldsEnriched?: FieldEnriched[] }

const PROVIDER_LABELS: Record<string, string> = {
  apollo: 'Apollo', unipile: 'Unipile', enrichSo: 'Enrich.so',
  webSearch: 'Web', sibling: 'Sibling', llm: 'Smart Fields LLM',
};
const PROVIDER_COLORS: Record<string, 'primary' | 'secondary' | 'success' | 'warning' | 'info' | 'default'> = {
  apollo: 'primary', unipile: 'info', enrichSo: 'secondary',
  webSearch: 'warning', sibling: 'default', llm: 'success',
};
const PROVIDER_HEX: Record<string, string> = {
  sibling: '#999999', apollo: '#0072B2', enrichSo: '#CC79A7',
  unipile: '#56B4E9', webSearch: '#E69F00', llm: '#009E73',
};

function totalFailed(job: EnrichmentJob): number {
  if (job.failedCount !== undefined) return job.failedCount;
  if (!job.failureBreakdown) return 0;
  return Object.values(job.failureBreakdown).reduce((a, b) => a + b, 0);
}

function aggregateBreakdown(jobs: EnrichmentJob[]): SourceBreakdown {
  const agg: SourceBreakdown = {};
  for (const job of jobs) {
    if (!job.sourceBreakdown) continue;
    for (const [key, val] of Object.entries(job.sourceBreakdown) as [keyof SourceBreakdown, SourceCount][]) {
      if (!agg[key]) agg[key] = { live: 0, cached: 0 };
      agg[key]!.live += val.live;
      agg[key]!.cached += val.cached;
    }
  }
  return agg;
}

function cacheHitRate(breakdown: SourceBreakdown): number | null {
  let total = 0, cached = 0;
  for (const v of Object.values(breakdown)) {
    if (!v) continue;
    total += v.live + v.cached;
    cached += v.cached;
  }
  if (total === 0) return null;
  return Math.round((cached / total) * 100);
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, tooltip }: { label: string; value: string | number; sub?: string; color?: string; tooltip?: React.ReactNode }) {
  const content = (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent sx={{ pb: '16px !important' }}>
        <Typography variant="body2" color="text.secondary" gutterBottom>{label}</Typography>
        <Typography variant="h4" fontWeight={700} color={color || 'text.primary'} sx={tooltip ? { cursor: 'help', borderBottom: '1px dashed', borderColor: 'text.disabled', display: 'inline-block' } : undefined}>{value}</Typography>
        {sub && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{sub}</Typography>}
      </CardContent>
    </Card>
  );
  if (tooltip) {
    return <Tooltip title={tooltip} arrow placement="top">{content}</Tooltip>;
  }
  return content;
}

// ─── Source Breakdown ─────────────────────────────────────────────────────────

const ALL_PROVIDERS: (keyof SourceBreakdown)[] = ['sibling', 'apollo', 'enrichSo', 'unipile', 'webSearch', 'llm'];

function SourceBreakdownChips({ breakdown }: { breakdown: SourceBreakdown }) {
  const entries = ALL_PROVIDERS.map(k => [k, breakdown[k] ?? { live: 0, cached: 0 }] as [keyof SourceBreakdown, SourceCount]);
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {entries.map(([key, v]) => (
        <Tooltip key={key} title={`${PROVIDER_LABELS[key]}: ${v.live} live / ${v.cached} cached`}>
          <Chip
            size="small"
            label={`${PROVIDER_LABELS[key]} ${v.live}L ${v.cached}C`}
            color={PROVIDER_COLORS[key] ?? 'default'}
            variant={v.cached > v.live ? 'outlined' : 'filled'}
          />
        </Tooltip>
      ))}
    </Box>
  );
}

function SourceBreakdownPie({ breakdown }: { breakdown: SourceBreakdown }) {
  const entries = ALL_PROVIDERS.map(k => [k, breakdown[k] ?? { live: 0, cached: 0 }] as [keyof SourceBreakdown, SourceCount]);
  const liveData = entries.map(([, v]) => v.live);
  const cachedData = entries.map(([, v]) => v.cached);
  const labels = entries.map(([k]) => PROVIDER_LABELS[k]);
  const colors = entries.map(([k]) => PROVIDER_HEX[k]);
  const total = entries.reduce((s, [, v]) => s + v.live + v.cached, 0);

  if (total === 0) return <Typography variant="body2" color="text.secondary">No data</Typography>;

  const data = {
    labels,
    datasets: [
      {
        label: 'Live',
        data: liveData,
        backgroundColor: colors.map(c => c + 'cc'),
        borderColor: colors,
        borderWidth: 1,
      },
      {
        label: 'Cached',
        data: cachedData,
        backgroundColor: colors.map(c => c + '99'),
        borderColor: colors,
        borderWidth: 1,
      },
    ],
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
      <Box sx={{ width: 200, height: 200 }}>
        <Pie data={data} options={{
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => ctx.datasetIndex === 0
                  ? `${labels[ctx.dataIndex]}: ${liveData[ctx.dataIndex]} live`
                  : `${labels[ctx.dataIndex]}: ${cachedData[ctx.dataIndex]} cached`,
              },
            },
          },
        }} />
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {entries.map(([key, v]) => (
          <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: PROVIDER_HEX[key], flexShrink: 0 }} />
            <Typography variant="body2" sx={{ minWidth: 70 }}>{PROVIDER_LABELS[key]}</Typography>
            <Typography variant="caption" color="text.secondary">
              {v.live} live · {v.cached} cached
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ─── Job Row ──────────────────────────────────────────────────────────────────

function JobRow({ job, token }: { job: EnrichmentJob; token: string }) {
  const [open, setOpen] = useState(false);
  const [leads, setLeads] = useState<LeadSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandError, setExpandError] = useState('');
  const failed = totalFailed(job);
  const jobSuccessful = (!job.successLeadsDeduplicationUnavailable && job.successfulLeadIds && !job.leadsDeduplicationUnavailable && job.attemptedLeadIds)
    ? { enriched: job.successfulLeadIds!.length, attempted: job.attemptedLeadIds!.length }
    : null;

  const handleExpand = async () => {
    if (!open && leads.length === 0) {
      setLoading(true);
      setExpandError('');
      try {
        const res = await axios.get(
          buildApiUrl(`/api/admin/lists/${job.listId}/enrichment-jobs/${job.jobId}`),
          { headers: { Authorization: `Bearer ${token}` } },
        );
        setLeads(res.data.leads || []);
      } catch (err: any) {
        setExpandError(err.response?.data?.message || 'Failed to load lead breakdown');
      } finally { setLoading(false); }
    }
    setOpen(o => !o);
  };

  return (
    <>
      <TableRow sx={{ '& > *': { borderBottom: 'unset' }, opacity: job.status === 'undone' ? 0.6 : 1 }}>
        <TableCell padding="checkbox">
          <IconButton size="small" onClick={handleExpand}>
            {open ? <CollapseIcon /> : <ExpandIcon />}
          </IconButton>
        </TableCell>
        <TableCell>
          <Typography variant="body2">{job.listName || job.listId}</Typography>
          {job.listName && (
            <Typography variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace', display: 'block' }}>
              {job.listId}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {new Date(job.createdAt).toLocaleString()}
          </Typography>
        </TableCell>
        <TableCell>
          <Chip
            size="small"
            icon={job.status === 'completed' ? <CheckIcon /> : <CancelIcon />}
            label={job.status}
            color={job.status === 'completed' ? 'success' : 'default'}
          />
        </TableCell>
        <TableCell align="right">
          <Tooltip title="Total leads enriched">
            <Typography variant="body2" fontWeight={600} color={jobSuccessful ? 'success.main' : 'text.secondary'} sx={{ cursor: 'default', display: 'inline-block' }}>
              {jobSuccessful ? `${jobSuccessful.enriched} / ${jobSuccessful.attempted}` : '—'}
            </Typography>
          </Tooltip>
          {(job.totalFieldsFilled !== undefined && job.totalFieldsAttempted) && (
            <Tooltip title="Total fields enriched">
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', cursor: 'default' }}>
                {job.totalFieldsFilled} / {job.totalFieldsAttempted}
              </Typography>
            </Tooltip>
          )}
        </TableCell>
        <TableCell align="right">
          <Typography variant="body2" color={job.skippedCount ? 'warning.main' : 'text.secondary'}>
            {job.skippedCount ? job.skippedCount : '—'}
          </Typography>
        </TableCell>
        <TableCell align="right">
          <Typography variant="body2" color={failed > 0 ? 'error.main' : 'text.secondary'}>
            {failed > 0 ? failed : '—'}
          </Typography>
        </TableCell>
        <TableCell>
          {job.sourceBreakdown
            ? <SourceBreakdownChips breakdown={job.sourceBreakdown} />
            : <Typography variant="body2" color="text.secondary">—</Typography>}
        </TableCell>
      </TableRow>

      <TableRow>
        <TableCell colSpan={7} sx={{ py: 0 }}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ m: 2 }}>
              <Typography variant="subtitle2" gutterBottom>Per-lead breakdown</Typography>
              {loading ? <CircularProgress size={20} /> : expandError ? (
                <Typography variant="body2" color="error.main">{expandError}</Typography>
              ) : leads.length === 0 ? (
                <Typography variant="body2" color="text.secondary">No per-lead data (run predates this feature).</Typography>
              ) : (
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Lead ID</TableCell>
                        <TableCell>Fields Enriched</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {leads.map(lead => (
                        <TableRow key={lead.leadId}>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap' }}>
                            {lead.leadId}
                          </TableCell>
                          <TableCell>
                            {lead.fieldsEnriched?.length ? (
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                {lead.fieldsEnriched.map((f, i) => (
                                  <Tooltip key={i} title={`${f.provider} · ${f.fromCache ? 'cached' : 'live'}`}>
                                    <Chip
                                      size="small"
                                      label={f.field}
                                      icon={f.fromCache ? <CacheIcon sx={{ fontSize: '12px !important' }} /> : <LiveIcon sx={{ fontSize: '12px !important' }} />}
                                      variant={f.fromCache ? 'outlined' : 'filled'}
                                      color={f.fromCache ? 'default' : 'primary'}
                                    />
                                  </Tooltip>
                                ))}
                              </Box>
                            ) : (
                              <Typography variant="body2" color="text.secondary">—</Typography>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────

interface AdminUser { userId: string; email: string; displayName?: string }
interface LeadList { listId: string; name: string; userId?: string }

export default function EnrichmentHistoryTab() {
  const { token } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [lists, setLists] = useState<LeadList[]>([]);

  useEffect(() => {
    if (!token) return;
    axios.get(buildApiUrl('/api/admin/users?hideBotLike=false'), {
      headers: { Authorization: `Bearer ${token}` },
    }).then(res => setUsers(res.data || [])).catch(() => {});
  }, [token]);
  const TIMEFRAMES = [
    { label: 'Today',        days: 0 },
    { label: 'Last 7 days',  days: 7 },
    { label: 'Last 30 days', days: 30 },
    { label: 'Last 90 days', days: 90 },
    { label: 'Last 180 days',days: 180 },
    { label: 'Last 365 days',days: 365 },
  ];
  const [timeframeDays, setTimeframeDays] = useState(30);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [selectedList, setSelectedList] = useState<LeadList | null>(null);
  const [jobs, setJobs] = useState<EnrichmentJob[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const buildParams = (days: number, token?: string) => {
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - (days === 0 ? 0 : days * 86400000));
    if (days === 0) startDate.setHours(0, 0, 0, 0);
    let p = `startDate=${startDate.toISOString()}&endDate=${endDate}`;
    if (token) p += `&nextToken=${encodeURIComponent(token)}`;
    return p;
  };

  useEffect(() => {
    if (!token) return;
    const q = selectedUser ? `?userId=${selectedUser.userId}` : '';
    axios.get(buildApiUrl(`/api/admin/lead-lists${q}`), {
      headers: { Authorization: `Bearer ${token}` },
    }).then(res => setLists(res.data || [])).catch(() => setLists([]));
    setSelectedList(null);
  }, [selectedUser, token]);

  const buildJobUrl = (days: number, paginationToken?: string, listId?: string, userId?: string) => {
    const params = buildParams(days, paginationToken);
    // List view: no date filter — show all runs for the list
    if (listId) {
      const p = paginationToken ? `nextToken=${encodeURIComponent(paginationToken)}` : '';
      return buildApiUrl(`/api/admin/lists/${listId}/enrichment-jobs${p ? `?${p}` : ''}`);
    }
    if (userId) return buildApiUrl(`/api/admin/users/${userId}/enrichment-jobs?${params}`);
    return buildApiUrl(`/api/admin/enrichment-jobs?${params}`);
  };

  const fetchSeqRef = useRef(0);

  const fetchJobs = useCallback(async (days: number, userId?: string, listId?: string) => {
    if (!token) return;
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setNextToken(undefined);
    setError('');
    try {
      const url = buildJobUrl(days, undefined, listId, userId);
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      if (seq !== fetchSeqRef.current) return;
      setJobs(res.data.jobs || []);
      setNextToken(res.data.nextToken);
    } catch (err: any) {
      if (seq !== fetchSeqRef.current) return;
      setError(err.response?.data?.message || 'Failed to fetch enrichment jobs');
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [token]);

  const loadMore = useCallback(async () => {
    if (!nextToken) return;
    setLoadingMore(true);
    try {
      const url = buildJobUrl(timeframeDays, nextToken, selectedList?.listId, selectedUser?.userId);
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      setJobs(prev => [...prev, ...(res.data.jobs || [])]);
      setNextToken(res.data.nextToken);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load more');
    } finally {
      setLoadingMore(false);
    }
  }, [nextToken, timeframeDays, selectedUser, selectedList, token]);

  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { fetchJobs(timeframeDays, selectedUser?.userId, selectedList?.listId); }, [timeframeDays, selectedUser, selectedList, fetchJobs]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && nextToken && !loadingMore) loadMore();
    }, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextToken, loadingMore, loadMore]);

  const completedJobs = jobs.filter(j => j.status === 'completed');
  const agg = aggregateBreakdown(completedJobs);
  const hitRate = cacheHitRate(agg);
  const skippedDedupable = completedJobs.filter(j => !j.skippedDeduplicationUnavailable && j.skippedLeadIds);
  const uniqueSkipped = new Set(skippedDedupable.flatMap(j => j.skippedLeadIds ?? [])).size;
  const totalSkipped = uniqueSkipped > 0 ? uniqueSkipped : completedJobs.reduce((a, j) => a + (j.skippedCount ?? 0), 0);
  const skippedIsDeduped = uniqueSkipped > 0;
  const totalFailures = completedJobs.reduce((a, j) => a + totalFailed(j), 0);
  const completedRuns = completedJobs.length;
  const perProviderRates = ALL_PROVIDERS.map(k => {
    const v = agg[k];
    if (!v) return null;
    const total = v.live + v.cached;
    if (total === 0) return null;
    return { label: PROVIDER_LABELS[k], rate: Math.round((v.cached / total) * 100), total };
  }).filter(Boolean) as { label: string; rate: number; total: number }[];

  const cacheTooltip = perProviderRates.length > 0 ? (
    <Box sx={{ p: 0.5 }}>
      {perProviderRates.map(p => (
        <Box key={p.label} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
          <Typography variant="caption">{p.label}</Typography>
          <Typography variant="caption" fontWeight={600}>{p.rate}%</Typography>
        </Box>
      ))}
    </Box>
  ) : undefined;

  const successDedupableJobs = completedJobs.filter(j =>
    !j.successLeadsDeduplicationUnavailable && j.successfulLeadIds &&
    !j.leadsDeduplicationUnavailable && j.attemptedLeadIds
  );
  const uniqueSuccessfulLeads = successDedupableJobs.length > 0
    ? new Set(successDedupableJobs.flatMap(j => j.successfulLeadIds ?? [])).size
    : null;
  const uniqueAttemptedLeads = successDedupableJobs.length > 0
    ? new Set(successDedupableJobs.flatMap(j => j.attemptedLeadIds ?? [])).size
    : null;

  return (
    <Box sx={{ mt: 4, pb: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Typography variant="h6">Enrichment Analytics</Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <Autocomplete
            size="small"
            sx={{ width: 260 }}
            options={users}
            getOptionLabel={u => u.email + (u.displayName ? ` (${u.displayName})` : '')}
            value={selectedUser}
            onChange={(_, val) => setSelectedUser(val)}
            renderInput={params => <TextField {...params} label="Filter by user" placeholder="All users" />}
            clearOnEscape
          />
          <Autocomplete
            size="small"
            sx={{ width: 260 }}
            options={lists}
            getOptionLabel={l => l.name || l.listId}
            getOptionKey={l => l.listId}
            value={selectedList}
            onChange={(_, val) => setSelectedList(val)}
            renderInput={params => <TextField {...params} label="Filter by list" placeholder="All lists" />}
            clearOnEscape
            noOptionsText={lists.length === 0 ? 'No lists found' : 'No match'}
          />
          <Tooltip title={selectedList ? 'Deselect the list to enable time filtering' : ''} placement="top">
            <span>
              <FormControl size="small" sx={{ width: 160 }} disabled={!!selectedList}>
                <InputLabel>Time frame</InputLabel>
                <Select
                  value={selectedList ? '' : timeframeDays}
                  label="Time frame"
                  onChange={e => setTimeframeDays(Number(e.target.value))}
                  displayEmpty={!!selectedList}
                  renderValue={selectedList ? () => '—' : undefined}
                >
                  {TIMEFRAMES.map(tf => (
                    <MenuItem key={tf.days} value={tf.days}>{tf.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </span>
          </Tooltip>
        </Box>
      </Box>
      {(selectedUser || selectedList) && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => { setSelectedUser(null); setSelectedList(null); }}>
          Showing enrichment history
          {selectedList && <> for list <strong>{selectedList.name || selectedList.listId}</strong></>}
          {selectedUser && <> · user <strong>{selectedUser.email}</strong></>}
        </Alert>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {/* ── Summary cards ── */}
          {nextToken && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Stats cover loaded runs only — scroll down to load more runs and update totals.
            </Alert>
          )}
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="Runs shown" value={jobs.length} sub={`${completedRuns} completed`} />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard
                label="Unique leads enriched"
                value={uniqueSuccessfulLeads !== null && uniqueAttemptedLeads !== null && uniqueAttemptedLeads > 0
                  ? `${uniqueSuccessfulLeads} / ${uniqueAttemptedLeads}`
                  : uniqueSuccessfulLeads !== null
                  ? String(uniqueSuccessfulLeads)
                  : '—'}
                sub={uniqueSuccessfulLeads !== null && uniqueAttemptedLeads !== null && uniqueAttemptedLeads > 0
                  ? 'unique leads'
                  : uniqueSuccessfulLeads !== null
                  ? 'attempted count unavailable'
                  : 'available on new runs'}
                color={uniqueSuccessfulLeads !== null && uniqueAttemptedLeads !== null && uniqueAttemptedLeads > 0
                  ? (uniqueSuccessfulLeads / uniqueAttemptedLeads >= 0.5 ? 'success.main' : 'warning.main')
                  : undefined}
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard
                label="Unresolvable"
                value={totalSkipped}
                sub={skippedIsDeduped ? 'unique leads' : undefined}
                color={totalSkipped > 0 ? 'warning.main' : undefined}
              />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <StatCard
                label="Failures"
                value={totalFailures}
                color={totalFailures > 0 ? 'error.main' : undefined}
              />
            </Grid>
            <Grid item xs={6} sm={4} md={3}>
              <StatCard
                label="Cache hit rate"
                value={hitRate !== null ? `${hitRate}%` : '—'}
                sub="hover for per-provider"
                color={hitRate !== null && hitRate >= 50 ? 'success.main' : undefined}
                tooltip={cacheTooltip}
              />
            </Grid>
          </Grid>

          {/* ── Aggregate source breakdown ── */}
          <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
            <Typography variant="subtitle2" gutterBottom>Aggregate Source Breakdown</Typography>
            <SourceBreakdownPie breakdown={agg} />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              Outer ring = live API calls · Inner ring = cache hits · counts are per-lead per-provider
            </Typography>
          </Paper>

          <Divider sx={{ mb: 2 }} />

          {/* ── Jobs table ── */}
          {jobs.length === 0 ? (
            <Typography color="text.secondary">No enrichment runs found.</Typography>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>Run / List</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Enriched</TableCell>
                    <TableCell align="right">Unresolvable</TableCell>
                    <TableCell align="right">Failures</TableCell>
                    <TableCell>Source Breakdown</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {jobs.map(job => (
                    <JobRow key={job.jobId} job={job} token={token!} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Box ref={sentinelRef} sx={{ py: 1, display: 'flex', justifyContent: 'center' }}>
            {loadingMore && <CircularProgress size={24} />}
          </Box>
        </>
      )}
    </Box>
  );
}
