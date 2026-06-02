import { useState, useEffect, useCallback } from 'react';
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
  userId?: string;
  createdAt: string;
  status: 'completed' | 'undone';
  processedCount: number;
  outputFields?: string[];
  failureBreakdown?: { searchWebFailed: number; linkedinFailed: number; llmOrParseFailed: number; updateFailed: number };
  sourceBreakdown?: SourceBreakdown;
}

interface FieldEnriched { field: string; provider: string; fromCache: boolean }
interface LeadSnapshot { leadId: string; fieldsEnriched?: FieldEnriched[] }

const PROVIDER_LABELS: Record<string, string> = {
  apollo: 'Apollo', unipile: 'Unipile', enrichSo: 'Enrich.so',
  webSearch: 'Web', sibling: 'Sibling', llm: 'LLM',
};
const PROVIDER_COLORS: Record<string, 'primary' | 'secondary' | 'success' | 'warning' | 'info' | 'default'> = {
  apollo: 'primary', unipile: 'info', enrichSo: 'secondary',
  webSearch: 'warning', sibling: 'default', llm: 'success',
};

function totalFailed(job: EnrichmentJob): number {
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

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent sx={{ pb: '16px !important' }}>
        <Typography variant="body2" color="text.secondary" gutterBottom>{label}</Typography>
        <Typography variant="h4" fontWeight={700} color={color || 'text.primary'}>{value}</Typography>
        {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
      </CardContent>
    </Card>
  );
}

// ─── Source Breakdown Chips ───────────────────────────────────────────────────

function SourceBreakdownChips({ breakdown, compact }: { breakdown: SourceBreakdown; compact?: boolean }) {
  const entries = (Object.entries(breakdown) as [keyof SourceBreakdown, SourceCount][])
    .filter(([, v]) => v && (v.live > 0 || v.cached > 0));
  if (!entries.length) return <Typography variant="body2" color="text.secondary">—</Typography>;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {entries.map(([key, v]) => (
        <Tooltip key={key} title={`${PROVIDER_LABELS[key]}: ${v.live} live / ${v.cached} cached`}>
          <Chip
            size="small"
            label={compact ? `${PROVIDER_LABELS[key]} ${v.live}L ${v.cached}C` : `${PROVIDER_LABELS[key]} ${v.live}↑ ${v.cached}⊙`}
            color={PROVIDER_COLORS[key] ?? 'default'}
            variant={v.cached > v.live ? 'outlined' : 'filled'}
          />
        </Tooltip>
      ))}
    </Box>
  );
}

// ─── Job Row ──────────────────────────────────────────────────────────────────

function JobRow({ job, token }: { job: EnrichmentJob; token: string }) {
  const [open, setOpen] = useState(false);
  const [leads, setLeads] = useState<LeadSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const failed = totalFailed(job);

  const handleExpand = async () => {
    if (!open && leads.length === 0) {
      setLoading(true);
      try {
        const res = await axios.get(
          buildApiUrl(`/api/admin/lists/${job.listId}/enrichment-jobs/${job.jobId}`),
          { headers: { Authorization: `Bearer ${token}` } },
        );
        setLeads(res.data.leads || []);
      } catch { /* leave empty */ }
      finally { setLoading(false); }
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
          <Typography variant="body2">{new Date(job.createdAt).toLocaleString()}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{job.listId}</Typography>
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
          <Typography variant="body2" fontWeight={600}>{job.processedCount}</Typography>
        </TableCell>
        <TableCell align="right">
          <Typography variant="body2" color={failed > 0 ? 'error.main' : 'text.secondary'}>
            {failed > 0 ? failed : '—'}
          </Typography>
        </TableCell>
        <TableCell>
          {job.sourceBreakdown
            ? <SourceBreakdownChips breakdown={job.sourceBreakdown} compact />
            : <Typography variant="body2" color="text.secondary">—</Typography>}
        </TableCell>
      </TableRow>

      <TableRow>
        <TableCell colSpan={6} sx={{ py: 0 }}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ m: 2 }}>
              <Typography variant="subtitle2" gutterBottom>Per-lead breakdown</Typography>
              {loading ? <CircularProgress size={20} /> : leads.length === 0 ? (
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

export default function EnrichmentHistoryTab() {
  const { token } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);

  useEffect(() => {
    axios.get(buildApiUrl('/api/admin/users?hideBotLike=false'), {
      headers: { Authorization: `Bearer ${token}` },
    }).then(res => setUsers(res.data || [])).catch(() => {});
  }, [token]);
  const [limit, setLimit] = useState(20);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [jobs, setJobs] = useState<EnrichmentJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchJobs = useCallback(async (n: number, userId?: string) => {
    setLoading(true);
    setError('');
    try {
      const url = userId
        ? buildApiUrl(`/api/admin/users/${userId}/enrichment-jobs?limit=${n}`)
        : buildApiUrl(`/api/admin/enrichment-jobs?limit=${n}`);
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      setJobs(res.data.jobs || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to fetch enrichment jobs');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchJobs(limit, selectedUser?.userId); }, [limit, selectedUser, fetchJobs]);

  const agg = aggregateBreakdown(jobs);
  const hitRate = cacheHitRate(agg);
  const totalProcessed = jobs.reduce((a, j) => a + j.processedCount, 0);
  const totalFailures = jobs.reduce((a, j) => a + totalFailed(j), 0);
  const completedRuns = jobs.filter(j => j.status === 'completed').length;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Typography variant="h6">Enrichment Analytics</Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <Autocomplete
            size="small"
            sx={{ width: 280 }}
            options={users}
            getOptionLabel={u => u.email + (u.displayName ? ` (${u.displayName})` : '')}
            value={selectedUser}
            onChange={(_, val) => setSelectedUser(val)}
            renderInput={params => <TextField {...params} label="Filter by user" placeholder="All users" />}
            clearOnEscape
          />
          <FormControl size="small" sx={{ width: 140 }}>
            <InputLabel>Show last</InputLabel>
            <Select value={limit} label="Show last" onChange={e => setLimit(Number(e.target.value))}>
              <MenuItem value={10}>10 runs</MenuItem>
              <MenuItem value={20}>20 runs</MenuItem>
              <MenuItem value={50}>50 runs</MenuItem>
              <MenuItem value={100}>100 runs</MenuItem>
            </Select>
          </FormControl>
        </Box>
      </Box>
      {selectedUser && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setSelectedUser(null)}>
          Showing enrichment history for <strong>{selectedUser.email}</strong>
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
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={6} sm={3}>
              <StatCard label="Runs shown" value={jobs.length} sub={`${completedRuns} completed`} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <StatCard label="Leads enriched" value={totalProcessed.toLocaleString()} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <StatCard
                label="Failures"
                value={totalFailures}
                color={totalFailures > 0 ? 'error.main' : undefined}
              />
            </Grid>
            <Grid item xs={6} sm={3}>
              <StatCard
                label="Cache hit rate"
                value={hitRate !== null ? `${hitRate}%` : '—'}
                sub="across all providers"
                color={hitRate !== null && hitRate >= 50 ? 'success.main' : undefined}
              />
            </Grid>
          </Grid>

          {/* ── Aggregate source breakdown ── */}
          {Object.keys(agg).length > 0 && (
            <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
              <Typography variant="subtitle2" gutterBottom>Aggregate Source Breakdown</Typography>
              <SourceBreakdownChips breakdown={agg} />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                ↑ live API call &nbsp;·&nbsp; ⊙ cache hit &nbsp;·&nbsp; counts are per-lead per-provider
              </Typography>
            </Paper>
          )}

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
                    <TableCell align="right">Leads</TableCell>
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
        </>
      )}
    </Box>
  );
}
