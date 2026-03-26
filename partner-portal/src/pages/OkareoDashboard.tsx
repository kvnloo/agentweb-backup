import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BuildIcon from '@mui/icons-material/Build';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DOMPurify from 'dompurify';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useAuth } from '../contexts/AuthContext';
import {
  listSimulations,
  listTargets,
  listDrivers,
  listScenarios,
  listChecks,
  getSimulationResults,
  Simulation,
  Target,
  Driver,
  Scenario,
  Check,
  SimulationResult,
  DataPoint,
  ToolCall,
} from '../services/okareoService';
import SimulationsTable from './OkareoDashboardTable';
import SimulationsCards from './OkareoDashboardCards';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 15;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function OkareoDashboard() {
  const { token } = useAuth();

  // list data
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);

  // ui state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');

  // filters
  const [search, setSearch] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [scenarioFilter, setScenarioFilter] = useState('');

  // pagination
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const perRunRef = useRef<HTMLDivElement | null>(null);

  // detail drawer
  const [detailSim, setDetailSim] = useState<Simulation | null>(null);
  const [detailResult, setDetailResult] = useState<SimulationResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // conversation drill-down inside detail drawer
  const [conversationRun, setConversationRun] = useState<{ index: number; datapoint: DataPoint } | null>(null);
  const [rawView, setRawView] = useState(false);

  // selection & compare
  const [selected, setSelected] = useState<string[]>([]);
  const [compareData, setCompareData] = useState<Record<string, SimulationResult> | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  // ── Load all list data on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    setLoading(true);
    Promise.all([
      listSimulations(token),  // needed for cards view
      listTargets(token),
      listDrivers(token),
      listScenarios(token),
      listChecks(token),
    ])
      .then(([sims, tgts, drvs, scens, chks]) => {
        setSimulations(sims);
        setTargets(tgts);
        setDrivers(drvs);
        setScenarios(scens);
        setChecks(chks);
      })
      .catch((err) => setError(err.message || 'Failed to load Okareo data.'))
      .finally(() => setLoading(false));
  }, [token]);

  // ── Lookup maps ──────────────────────────────────────────────────────────
  const targetMap = useMemo(
    () => Object.fromEntries(targets.map((t) => [t.id, t.name])),
    [targets]
  );
  const driverMap = useMemo(
    () => Object.fromEntries(drivers.map((d) => [d.id, d.name])),
    [drivers]
  );
  const scenarioMap = useMemo(
    () => Object.fromEntries(scenarios.map((s) => [s.scenario_id, s.name || s.scenario_id])),
    [scenarios]
  );

  // ── Filtered simulations (cards view) ────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return simulations.filter((sim) => {
      if (q && !(sim.name?.toLowerCase() || '').includes(q)) return false;
      if (targetFilter && sim.mut_id !== targetFilter) return false;
      if (driverFilter && sim.driver_id !== driverFilter) return false;
      if (scenarioFilter && sim.scenario_set_id !== scenarioFilter) return false;
      return true;
    });
  }, [simulations, search, targetFilter, driverFilter, scenarioFilter]);

  // Reset display count whenever filters change
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [search, targetFilter, driverFilter, scenarioFilter]);

  // ── Infinite scroll via IntersectionObserver ─────────────────────────────
  const loadMore = useCallback(() => {
    setDisplayCount((prev) => Math.min(prev + PAGE_SIZE, filtered.length));
  }, [filtered.length]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  const visibleSims = useMemo(
    () => filtered.slice(0, displayCount),
    [filtered, displayCount]
  );
  const hasMore = displayCount < filtered.length;

  const hasFilters = search || targetFilter || driverFilter || scenarioFilter;

  function clearFilters() {
    setSearch('');
    setTargetFilter('');
    setDriverFilter('');
    setScenarioFilter('');
  }

  // ── Detail drawer ────────────────────────────────────────────────────────
  async function openDetail(sim: Simulation) {
    setDetailSim(sim);
    setDetailResult(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const result = await getSimulationResults(token!, sim.id);
      setDetailResult(result);
    } catch (err: any) {
      setDetailError(err.message || 'Failed to load simulation details.');
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetailSim(null);
    setDetailResult(null);
    setDetailError(null);
    setConversationRun(null);
  }

  // ── Selection ────────────────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // ── Compare ──────────────────────────────────────────────────────────────
  async function handleCompare() {
    if (!token || selected.length < 2) return;
    setCompareLoading(true);
    setCompareError(null);
    try {
      const results = await Promise.all(
        selected.map((id) => getSimulationResults(token, id))
      );
      const map: Record<string, SimulationResult> = {};
      results.forEach((r) => { map[r.id] = r; });
      setCompareData(map);
    } catch (err: any) {
      setCompareError(err.message || 'Failed to load comparison data.');
    } finally {
      setCompareLoading(false);
    }
  }

  function handleBack() {
    setCompareData(null);
    setCompareError(null);
  }

  // ── Render: loading / error ──────────────────────────────────────────────
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error" sx={{ mt: 4 }}>{error}</Alert>;
  }

  // ── Render: compare view ─────────────────────────────────────────────────
  if (compareData) {
    const selectedSims = selected.map((id) => compareData[id]).filter(Boolean);
    const originalSims = selected.map((id) => simulations.find((s) => s.id === id)).filter((s): s is Simulation => !!s);

    const uniqueScenarios = new Set(selectedSims.map((s) => s.scenario_set_id).filter(Boolean));
    const uniqueDrivers = new Set(originalSims.map((s) => s.driver_id).filter(Boolean));
    const scenarioMismatch = uniqueScenarios.size > 1;
    const driverMismatch = uniqueDrivers.size > 1;

    const allCheckKeys = Array.from(
      new Set(selectedSims.flatMap((s) => Object.keys(s.model_metrics?.mean_scores || {})))
    );

    return (
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 3, gap: 1 }}>
          <IconButton onClick={handleBack} color="primary">
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="h5" fontWeight={600}>
            Simulation Comparison
          </Typography>
        </Box>

        {compareError && <Alert severity="error" sx={{ mb: 2 }}>{compareError}</Alert>}

        {(scenarioMismatch || driverMismatch) && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {scenarioMismatch && <li>These simulations use different scenarios — per-run rows do not correspond to the same inputs.</li>}
              {driverMismatch && <li>These simulations use different drivers — aggregate scores may not be directly comparable.</li>}
            </ul>
          </Alert>
        )}

        {/* Summary table */}
        <Typography variant="h6" sx={{ mb: 1 }}>Summary</Typography>
        <TableContainer component={Paper} sx={{ mb: 4 }}>
          <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600, width: 160 }}>Field</TableCell>
                {selectedSims.map((s) => (
                  <TableCell key={s.id} align="center" sx={{ fontWeight: 600 }}>{s.name || s.id}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {[
                { label: 'Status', getValue: (s: SimulationResult) => s.status || '—' },
                { label: 'Target', getValue: (s: SimulationResult) => s.mut_id ? (targetMap[s.mut_id] || s.mut_id) : '—' },
                { label: 'Driver', getValue: (s: SimulationResult) => {
                  const orig = originalSims.find((o) => o.id === s.id);
                  return orig?.driver_id ? (driverMap[orig.driver_id] || orig.driver_id) : '—';
                }},
                { label: 'Scenario', getValue: (s: SimulationResult) => s.scenario_set_id ? (scenarioMap[s.scenario_set_id] || s.scenario_set_id) : '—' },
                { label: 'Date', getValue: (s: SimulationResult) => formatDate(s.start_time) },
              ].map(({ label, getValue }) => (
                <TableRow key={label}>
                  <TableCell sx={{ fontWeight: 500, color: 'text.secondary' }}>{label}</TableCell>
                  {selectedSims.map((s) => (
                    <TableCell key={s.id} align="center">{getValue(s)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>

        {/* Run metadata */}
        {selectedSims.some((s) => s.model_metrics?.aggregate_check_metadata) && (
          <>
            <Typography variant="h6" sx={{ mb: 1 }}>Run Metadata</Typography>
            <TableContainer component={Paper} sx={{ mb: 4 }}>
              <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600, width: 160 }}>Metric</TableCell>
                    {selectedSims.map((s) => (
                      <TableCell key={s.id} align="center" sx={{ fontWeight: 600 }}>{s.name || s.id}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[
                    { label: 'Avg Latency', getValue: (meta: Record<string, number>) => meta.average_latency ? `${(meta.average_latency / 1000).toFixed(2)}s` : '—' },
                    { label: 'Input Tokens', getValue: (meta: Record<string, number>) => meta.total_input_tokens?.toLocaleString() ?? '—' },
                    { label: 'Output Tokens', getValue: (meta: Record<string, number>) => meta.total_output_tokens?.toLocaleString() ?? '—' },
                    { label: 'Cost', getValue: (meta: Record<string, number>) => meta.total_cost != null ? `$${Number(meta.total_cost).toFixed(4)}` : '—' },
                  ].map(({ label, getValue }) => (
                    <TableRow key={label}>
                      <TableCell sx={{ fontWeight: 500, color: 'text.secondary' }}>{label}</TableCell>
                      {selectedSims.map((s) => (
                        <TableCell key={s.id} align="center">
                          {getValue(s.model_metrics?.aggregate_check_metadata || {})}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}

        {/* Check scores */}
        <Typography variant="h6" sx={{ mb: 1 }}>Check Scores</Typography>
        <TableContainer component={Paper} sx={{ mb: 4 }}>
          <Table size="small" sx={{ tableLayout: 'fixed', width: '100%' }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600, width: 160 }}>Check</TableCell>
                {selectedSims.map((s) => (
                  <TableCell key={s.id} align="center" sx={{ fontWeight: 600 }}>{s.name || s.id}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {allCheckKeys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={selectedSims.length + 1} align="center">
                    {selectedSims.every((s) => Object.keys(s.model_metrics?.mean_scores || {}).length > 0)
                      ? 'No checks in common between the selected simulations.'
                      : 'No check scores available.'}
                  </TableCell>
                </TableRow>
              ) : (
                allCheckKeys.map((key) => (
                  <TableRow key={key}>
                    <TableCell sx={{ textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</TableCell>
                    {selectedSims.map((s) => {
                      const val = s.model_metrics?.mean_scores?.[key];
                      const isScale5 = typeof val === 'number' && val > 1;
                      const display = val == null ? '—'
                        : isScale5 ? `${val.toFixed(2)} / 5`
                        : typeof val === 'number' ? `${(val * 100).toFixed(1)}%`
                        : String(val);
                      return <TableCell key={s.id} align="center">{display}</TableCell>;
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>

      </Box>
    );
  }

  // ── Render: simulations list ─────────────────────────────────────────────
  return (
    <Box>
      <Typography variant="h4" fontWeight={600} sx={{ mb: 2 }}>
        Okareo Simulations
      </Typography>

      {/* View toggle */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs value={viewMode} onChange={(_, v) => setViewMode(v as 'table' | 'cards')}>
          <Tab label="Table View" value="table" />
          <Tab label="Card View" value="cards" />
        </Tabs>
      </Box>

      {/* ── Table View ──────────────────────────────────────────────────── */}
      {viewMode === 'table' && (
        <SimulationsTable
          token={token!}
          scenarios={scenarios}
          targets={targets}
          drivers={drivers}
          checks={checks}
          onSimClick={openDetail}
        />
      )}

      {/* ── Card View ───────────────────────────────────────────────────── */}
      {viewMode === 'cards' && (
        <SimulationsCards
          visibleSims={visibleSims}
          filtered={filtered}
          simulations={simulations}
          hasMore={hasMore}
          sentinelRef={sentinelRef}
          search={search}
          onSearchChange={setSearch}
          targetFilter={targetFilter}
          onTargetFilterChange={setTargetFilter}
          driverFilter={driverFilter}
          onDriverFilterChange={setDriverFilter}
          scenarioFilter={scenarioFilter}
          onScenarioFilterChange={setScenarioFilter}
          targets={targets}
          drivers={drivers}
          scenarios={scenarios}
          targetMap={targetMap}
          driverMap={driverMap}
          scenarioMap={scenarioMap}
          selected={selected}
          onToggleSelect={toggleSelect}
          onCompare={handleCompare}
          compareLoading={compareLoading}
          hasFilters={!!hasFilters}
          onClearFilters={clearFilters}
          onSimClick={openDetail}
        />
      )}

      {/* ── Detail Drawer ───────────────────────────────────────────────── */}
      <Drawer
        anchor="right"
        open={!!detailSim}
        onClose={closeDetail}
        PaperProps={{
          sx: {
            width: { xs: '100vw', sm: 600, md: 800 },
            p: 3
          }
        }}
      >
        {detailSim && (
          <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header */}
            <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 2 }}>
              <Box sx={{ flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Chip
                    label={detailSim.status || 'unknown'}
                    size="small"
                    color={
                      detailSim.status === 'COMPLETE' || detailSim.status === 'FINISHED' ? 'success'
                      : detailSim.status === 'RUNNING' ? 'info'
                      : detailSim.status === 'FAILED' ? 'error'
                      : 'default'
                    }
                  />
                  {detailResult?.app_link && (
                    <Tooltip title="Open in Okareo">
                      <IconButton size="small" href={detailResult.app_link} target="_blank" rel="noopener">
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
                <Typography variant="h6" fontWeight={700} sx={{ lineHeight: 1.3 }}>
                  {detailSim.name || detailSim.id}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatDate(detailSim.start_time)}
                  {detailSim.end_time && ` → ${formatDate(detailSim.end_time)}`}
                </Typography>
              </Box>
              <IconButton onClick={closeDetail} size="small" sx={{ ml: 1 }}>
                <CloseIcon />
              </IconButton>
            </Box>

            <Divider sx={{ mb: 2 }} />

            {detailLoading && <LinearProgress sx={{ mb: 2 }} />}
            {detailError && <Alert severity="error" sx={{ mb: 2 }}>{detailError}</Alert>}

            {detailResult && (
              <Box sx={{
                flex: 1,
                overflow: 'auto',
                '&::-webkit-scrollbar': { width: 6 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': { background: 'rgba(0,0,0,0.15)', borderRadius: 3 },
                '&::-webkit-scrollbar-thumb:hover': { background: 'rgba(0,0,0,0.3)' },
              }}>

                {/* Meta row */}
                <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Target', value: detailSim.mut_id ? (targetMap[detailSim.mut_id] || '—') : '—' },
                    { label: 'Driver', value: detailSim.driver_id ? (driverMap[detailSim.driver_id] || '—') : '—' },
                    { label: 'Scenario', value: detailSim.scenario_set_id ? (scenarioMap[detailSim.scenario_set_id] || '—') : '—' },
                  ].map(({ label, value }) => (
                    <Box key={label} sx={{ minWidth: 100 }}>
                      <Typography variant="caption" color="text.secondary">{label}</Typography>
                      <Typography variant="body2" fontWeight={500} noWrap>{String(value)}</Typography>
                    </Box>
                  ))}
                  <Box sx={{ minWidth: 100 }}>
                    <Typography variant="caption" color="text.secondary">Turns / Run</Typography>
                    <Tooltip title="Jump to Per-Run Results" placement="right">
                      <Typography
                        variant="body2"
                        fontWeight={500}
                        noWrap
                        onClick={() => perRunRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                        sx={{ cursor: 'pointer', color: 'primary.main' }}
                      >
                        {String(detailSim.test_data_point_count ?? '—')}
                      </Typography>
                    </Tooltip>
                  </Box>
                </Stack>

                {/* Aggregate metadata */}
                {(() => {
                  const meta = detailResult.model_metrics?.aggregate_check_metadata;
                  if (!meta) return null;
                  const items = [
                    { label: 'Avg Latency', value: meta.average_latency ? `${(meta.average_latency / 1000).toFixed(2)}s` : '—' },
                    { label: 'Input Tokens', value: meta.total_input_tokens?.toLocaleString() ?? '—' },
                    { label: 'Output Tokens', value: meta.total_output_tokens?.toLocaleString() ?? '—' },
                    { label: 'Cost', value: meta.total_cost != null ? `$${Number(meta.total_cost).toFixed(4)}` : '—' },
                  ];
                  return (
                    <>
                      <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>Run Metadata</Typography>
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(2, 1fr)',
                          gap: 1.5,
                          mb: 3,
                        }}
                      >
                        {items.map(({ label, value }) => (
                          <Paper key={label} variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
                            <Typography variant="caption" color="text.secondary">{label}</Typography>
                            <Typography variant="body1" fontWeight={700}>{value}</Typography>
                          </Paper>
                        ))}
                      </Box>
                    </>
                  );
                })()}

                {/* No metrics notice */}
                {(() => {
                  const hasMeanScores = detailResult.model_metrics?.mean_scores &&
                    Object.keys(detailResult.model_metrics.mean_scores).length > 0;
                  if (hasMeanScores) return null;

                  const status = detailSim.status?.toUpperCase();
                  let severity: 'info' | 'warning' | 'error' = 'info';
                  let message: string;

                  if (status === 'RUNNING') {
                    severity = 'info';
                    message = 'This simulation is still running — metrics will appear once it completes.';
                  } else if (status === 'PENDING') {
                    severity = 'info';
                    message = 'This simulation is queued and has not started yet.';
                  } else if (status === 'FAILED') {
                    severity = 'error';
                    message = 'This simulation failed — no metrics were recorded.';
                  } else if (detailResult.model_metrics?.aggregate_check_metadata) {
                    severity = 'warning';
                    message = 'The simulation completed but no checks were configured, so there are no scores to display.';
                  } else {
                    severity = 'warning';
                    message = 'No metrics were recorded for this simulation.';
                  }

                  return <Alert severity={severity} sx={{ mb: 3 }}>{message}</Alert>;
                })()}

                {/* Check scores */}
                {(() => {
                  const mean = detailResult.model_metrics?.mean_scores;
                  if (!mean || !Object.keys(mean).length) return null;
                  return (
                    <>
                      <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1.5 }}>Check Scores</Typography>
                      <Stack spacing={1.5} sx={{ mb: 3 }}>
                        {Object.entries(mean).map(([key, raw]) => {
                          const val = typeof raw === 'number' ? raw : null;
                          // Scores may be 0–1 (boolean checks) or 0–5 (toxicity scale)
                          const isScale5 = val !== null && val > 1;
                          const pct = val === null ? null : isScale5 ? (val / 5) * 100 : val * 100;
                          const displayVal = val === null ? '—'
                            : isScale5 ? `${val.toFixed(2)} / 5`
                            : `${(val * 100).toFixed(1)}%`;
                          const color = pct === null ? 'grey.400'
                            : pct >= 70 ? 'success.main'
                            : pct >= 40 ? 'warning.main'
                            : 'error.main';
                          return (
                            <Box key={key}>
                              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                                <Typography variant="body2" sx={{ textTransform: 'capitalize' }}>
                                  {key.replace(/_/g, ' ')}
                                </Typography>
                                <Typography variant="body2" fontWeight={600} color={color}>
                                  {displayVal}
                                </Typography>
                              </Box>
                              <LinearProgress
                                variant="determinate"
                                value={pct ?? 0}
                                sx={{
                                  height: 6,
                                  borderRadius: 3,
                                  bgcolor: 'grey.200',
                                  '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: 3 },
                                }}
                              />
                            </Box>
                          );
                        })}
                      </Stack>
                    </>
                  );
                })()}

                {/* Per-row scores summary */}
                {(() => {
                  const rows = [...(detailResult.model_metrics?.scores_by_row ?? [])].sort(
                    (a: any, b: any) => (a.scenario_index ?? 0) - (b.scenario_index ?? 0)
                  );
                  if (!rows?.length) return null;
                  const checkKeys = Object.keys(rows[0]).filter(
                    (k) => !['test_id', 'scenario_index'].includes(k) && !k.endsWith('__explanation')
                  );
                  if (!checkKeys.length) return null;
                  return (
                    <>
                      <Typography ref={perRunRef} variant="subtitle2" fontWeight={600} sx={{ mb: 0.5 }}>Per-Run Results</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                        Click a row to view its conversation.
                      </Typography>
                      <TableContainer component={Paper} variant="outlined" sx={{
                        borderRadius: 2,
                        '&::-webkit-scrollbar': { height: 6 },
                        '&::-webkit-scrollbar-track': { background: 'transparent' },
                        '&::-webkit-scrollbar-thumb': { background: 'rgba(0,0,0,0.15)', borderRadius: 3 },
                        '&::-webkit-scrollbar-thumb:hover': { background: 'rgba(0,0,0,0.3)' },
                      }}>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell sx={{ fontWeight: 600 }}>#</TableCell>
                              {checkKeys.map((k) => (
                                <TableCell key={k} align="center" sx={{ fontWeight: 600, textTransform: 'capitalize', fontSize: 11 }}>
                                  {k.replace(/_/g, ' ')}
                                </TableCell>
                              ))}
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {rows.map((row: any, i: number) => {
                              const runIndex = row.scenario_index ?? i + 1;
                              const dp = detailResult.datapoints?.find((d) => d.id === row.test_id);
                              return (
                                <TableRow
                                  key={row.test_id || i}
                                  onClick={() => { setRawView(false); setConversationRun({ index: runIndex, datapoint: dp ?? null as unknown as DataPoint }); }}
                                  sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                                >
                                  <TableCell>{runIndex}</TableCell>
                                  {checkKeys.map((k) => {
                                    const v = row[k];
                                    if (v === null || v === undefined) return <TableCell key={k} align="center">—</TableCell>;
                                    if (typeof v === 'boolean') {
                                      return (
                                        <TableCell key={k} align="center">
                                          <Chip label={v ? 'Pass' : 'Fail'} size="small" color={v ? 'success' : 'error'} />
                                        </TableCell>
                                      );
                                    }
                                    if (typeof v === 'number') {
                                      return (
                                        <TableCell key={k} align="center">
                                          <Typography variant="caption" fontWeight={600}>
                                            {v > 1 ? v.toFixed(2) : `${(v * 100).toFixed(0)}%`}
                                          </Typography>
                                        </TableCell>
                                      );
                                    }
                                    return <TableCell key={k} align="center"><Typography variant="caption">{String(v)}</Typography></TableCell>;
                                  })}
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </>
                  );
                })()}
              </Box>
            )}

            {/* ── Conversation view ── */}
            {conversationRun && detailResult && (
              <Box sx={{
                position: 'absolute', inset: 0, bgcolor: 'background.paper', p: 3,
                display: 'flex', flexDirection: 'column',
              }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <IconButton size="small" onClick={() => setConversationRun(null)}>
                    <ArrowBackIcon />
                  </IconButton>
                  <Typography variant="h6" fontWeight={600} sx={{ flex: 1 }}>
                    Run #{conversationRun.index} — Conversation
                  </Typography>
                  <Button
                    size="small"
                    variant={rawView ? 'contained' : 'outlined'}
                    onClick={() => setRawView((v) => !v)}
                  >
                    {rawView ? 'Formatted' : 'Raw Output'}
                  </Button>
                </Box>
                <Divider sx={{ mb: 2 }} />
                <Box sx={{
                  flex: 1, overflow: 'auto',
                  '&::-webkit-scrollbar': { width: 6 },
                  '&::-webkit-scrollbar-track': { background: 'transparent' },
                  '&::-webkit-scrollbar-thumb': { background: 'rgba(0,0,0,0.15)', borderRadius: 3 },
                  '&::-webkit-scrollbar-thumb:hover': { background: 'rgba(0,0,0,0.3)' },
                }}>
                  {(() => {
                    const turns = (conversationRun.datapoint?.metric_value?.generation_output ?? [])
                      .filter((t) => t.role !== 'system' && t.role !== 'tool');
                    if (!turns.length) {
                      return <Typography color="text.secondary">No conversation data available for this run.</Typography>;
                    }
                    return turns.map((turn, i) => (
                      <Box
                        key={i}
                        sx={{
                          mb: 1.5, p: 1.5, borderRadius: 2,
                          bgcolor: turn.role === 'user' ? 'primary.50' : 'grey.100',
                          border: '1px solid',
                          borderColor: turn.role === 'user' ? 'primary.200' : 'grey.300',
                        }}
                      >
                        <Typography variant="caption" fontWeight={700} sx={{ textTransform: 'uppercase', color: 'text.secondary', display: 'block', mb: 0.5 }}>
                          {turn.role}
                        </Typography>
                        {rawView ? (
                          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                            {turn.content}
                          </Typography>
                        ) : (
                          <Box
                            sx={{ fontSize: 14, lineHeight: 1.6, '& ul, & ol': { pl: 2.5 }, '& li': { mb: 0.25 }, '& blockquote': { borderLeft: '3px solid', borderColor: 'grey.300', pl: 1.5, ml: 0, color: 'text.secondary' }, '& strong': { fontWeight: 700 } }}
                            dangerouslySetInnerHTML={{
                              __html: DOMPurify.sanitize(
                                turn.content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/^---$/gm, '<hr/>'),
                                { ADD_TAGS: ['strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br'] }
                              ),
                            }}
                          />
                        )}

                        {/* Tool calls */}
                        {turn.tool_calls && turn.tool_calls.length > 0 && (
                          <Box sx={{ mt: 1.5 }}>
                            {turn.tool_calls.map((tc: ToolCall, ti: number) => (
                              <Accordion
                                key={tc.id || ti}
                                disableGutters
                                elevation={0}
                                sx={{
                                  border: '1px solid',
                                  borderColor: 'divider',
                                  borderRadius: '6px !important',
                                  mb: 0.75,
                                  '&:before': { display: 'none' },
                                }}
                              >
                                <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 16 }} />} sx={{ minHeight: 36, px: 1.5, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                    <BuildIcon sx={{ fontSize: 13, color: 'text.disabled' }} />
                                    <Typography variant="caption" fontWeight={600} sx={{ fontFamily: 'monospace' }}>
                                      {tc.name}
                                    </Typography>
                                    {tc.duration != null && (
                                      <Typography variant="caption" color="text.disabled">{tc.duration}ms</Typography>
                                    )}
                                  </Box>
                                </AccordionSummary>
                                <AccordionDetails sx={{ px: 1.5, pt: 0, pb: 1.5 }}>
                                  {tc.arguments && Object.keys(tc.arguments).length > 0 && (
                                    <Box sx={{ mb: 1 }}>
                                      <Typography variant="caption" color="text.secondary" fontWeight={600}>Arguments</Typography>
                                      <Box component="pre" sx={{ fontSize: 11, bgcolor: 'grey.50', p: 1, borderRadius: 1, overflow: 'auto', mt: 0.5, m: 0 }}>
                                        {JSON.stringify(tc.arguments, null, 2)}
                                      </Box>
                                    </Box>
                                  )}
                                  {tc.result !== undefined && (
                                    <Box>
                                      <Typography variant="caption" color="text.secondary" fontWeight={600}>Result</Typography>
                                      <Box component="pre" sx={{ fontSize: 11, bgcolor: 'grey.50', p: 1, borderRadius: 1, overflow: 'auto', mt: 0.5, m: 0 }}>
                                        {typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}
                                      </Box>
                                    </Box>
                                  )}
                                </AccordionDetails>
                              </Accordion>
                            ))}
                          </Box>
                        )}
                      </Box>
                    ));
                  })()}
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Drawer>
    </Box>
  );
}
