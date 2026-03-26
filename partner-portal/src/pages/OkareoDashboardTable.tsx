import { useEffect, useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  LinearProgress,
  ListItemText,
  Paper,
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
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import { Check, Driver, Scenario, Simulation, Target, listSimulations } from '../services/okareoService';

// ─── Constants ────────────────────────────────────────────────────────────────

// Explicitly excluded from quality aggregate (operational or out-of-scope metrics)
const EXCLUDED_METRICS = new Set([
  'total_turn_count', 'empathy_score',
  'latency', 'avg_turn_latency', 'avg_turn_taking_latency',
  'total_input_tokens', 'total_output_tokens', 'total_cost',
  'input_tokens', 'output_tokens', 'cost', 'avg_words_per_minute',
]);

// ─── Check metadata parsing ───────────────────────────────────────────────────

interface CheckMeta {
  min: number;
  max: number;
  isBinary: boolean;
}

const BINARY_PATTERNS = [
  /pass\/fail/i,
  /pass_fail/i,
  /returns?\s+true/i,
  /output is (a )?1 (if|or)/i,
  /outputs? (a )?pass/i,
  /check will pass/i,
  /\(1 or 0\)/i,
  /1 if .* (otherwise|0 if)/is,
];

export function parseCheckMeta(description: string): CheckMeta | null {
  if (BINARY_PATTERNS.some((p) => p.test(description))) {
    return { min: 0, max: 1, isBinary: true };
  }
  // "Ranges from X to Y"
  const rangesMatch = description.match(/[Rr]anges?\s+from\s+([\d.]+)\s+to\s+([\d.]+)/);
  if (rangesMatch) {
    return { min: parseFloat(rangesMatch[1]), max: parseFloat(rangesMatch[2]), isBinary: false };
  }
  // "Score X-Y" or "Score 1-5" (custom checks)
  const scoreMatch = description.match(/[Ss]cores?\s+([\d.]+)\s*[-–]\s*([\d.]+)/);
  if (scoreMatch) {
    return { min: parseFloat(scoreMatch[1]), max: parseFloat(scoreMatch[2]), isBinary: false };
  }
  return null;
}

export function buildCheckMetaMap(checks: Check[]): Record<string, CheckMeta> {
  const map: Record<string, CheckMeta> = {};
  for (const check of checks) {
    const meta = parseCheckMeta(check.description);
    if (meta) map[check.name] = meta;
  }
  return map;
}

// ─── Score helpers ────────────────────────────────────────────────────────────

function normalizeValue(num: number, meta: CheckMeta | undefined): number | null {
  if (meta?.isBinary) return num; // already 0 or 1
  if (meta && meta.max > meta.min) {
    // Proper min-max normalization — clamped to [0, 1]
    return Math.max(0, Math.min(1, (num - meta.min) / (meta.max - meta.min)));
  }
  // Fallback heuristic for checks with no parseable description
  if (num === 0 || num === 1) return num;
  if (num > 0 && num < 1) return num;
  if (num > 1 && num <= 5) return (num - 1) / 4; // likely 1-5 LLM judge
  return null; // truly unknown scale (e.g. > 5) — exclude from aggregate
}

export function computeAggregateScore(
  model_metrics?: Record<string, any>,
  checkMetaMap: Record<string, CheckMeta> = {}
): number | null {
  const mean = model_metrics?.mean_scores;
  if (!mean) return null;
  const values: number[] = [];
  for (const [key, raw] of Object.entries(mean)) {
    if (EXCLUDED_METRICS.has(key)) continue;
    if (key.endsWith('__explanation') || key === 'test_id' || key === 'scenario_index') continue;
    if (raw === null || raw === undefined || typeof raw === 'string') continue; // analysis type
    const num = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    if (isNaN(num)) continue;
    const normalized = normalizeValue(num, checkMetaMap[key]);
    if (normalized !== null) values.push(normalized);
  }
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

interface MetricEntry {
  key: string;
  raw: number | boolean | null;
  normalized: number | null;
  isBinary: boolean;
  unknownScale: boolean; // excluded from aggregate — shown separately in tooltip
}

function getMetricBreakdown(
  model_metrics?: Record<string, any>,
  checkMetaMap: Record<string, CheckMeta> = {}
): MetricEntry[] {
  const mean = model_metrics?.mean_scores;
  if (!mean) return [];
  const result: MetricEntry[] = [];
  for (const [key, raw] of Object.entries(mean)) {
    if (EXCLUDED_METRICS.has(key)) continue;
    if (key.endsWith('__explanation') || key === 'test_id' || key === 'scenario_index') continue;
    if (raw === null || raw === undefined || typeof raw === 'string') continue; // analysis type
    const num = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    if (isNaN(num)) continue;
    const meta = checkMetaMap[key];
    const normalized = normalizeValue(num, meta);
    result.push({
      key,
      raw: typeof raw === 'boolean' ? raw : num,
      normalized,
      isBinary: meta?.isBinary ?? (num === 0 || num === 1),
      unknownScale: normalized === null,
    });
  }
  return result;
}

function scoreColor(score: number | null): string {
  if (score === null) return 'text.disabled';
  if (score >= 0.75) return 'success.main';
  if (score >= 0.5) return 'warning.main';
  return 'error.main';
}

// ─── ScoreCellTooltip ─────────────────────────────────────────────────────────

function MetricRow({ m }: { m: MetricEntry }) {
  return (
    <Box sx={{ mb: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
        <Typography variant="caption" sx={{ textTransform: 'capitalize', opacity: 0.9 }}>
          {m.key.replace(/_/g, ' ')}
        </Typography>
        <Typography variant="caption" fontWeight={700} sx={{ color: scoreColor(m.normalized) }}>
          {m.normalized !== null ? `${(m.normalized * 100).toFixed(0)}%` : '—'}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={(m.normalized ?? 0) * 100}
        sx={{
          height: 4, borderRadius: 2,
          bgcolor: 'rgba(255,255,255,0.15)',
          '& .MuiLinearProgress-bar': { bgcolor: scoreColor(m.normalized), borderRadius: 2 },
        }}
      />
    </Box>
  );
}

function ScoreCellTooltip({
  sims,
  checkMetaMap,
}: {
  sims: Simulation[];
  checkMetaMap: Record<string, CheckMeta>;
}) {
  const latest = sims[0];
  const breakdown = getMetricBreakdown(latest.model_metrics, checkMetaMap);
  const aggregate = computeAggregateScore(latest.model_metrics, checkMetaMap);
  const opMeta = latest.model_metrics?.aggregate_check_metadata;

  const passFail = breakdown.filter((m) => m.isBinary && !m.unknownScale);
  const scores = breakdown.filter((m) => !m.isBinary && !m.unknownScale);
  const unknown = breakdown.filter((m) => m.unknownScale);

  return (
    <Box sx={{ p: 1.5, minWidth: 260, maxWidth: 360 }}>
      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>
        Aggregate:{' '}
        <Box component="span" sx={{ color: scoreColor(aggregate) }}>
          {aggregate !== null ? `${(aggregate * 100).toFixed(1)}%` : '—'}
        </Box>
      </Typography>

      {passFail.length > 0 && (
        <>
          <Typography variant="caption" sx={{ display: 'block', mb: 0.75, fontWeight: 700, opacity: 0.7, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 10 }}>
            Pass / Fail
          </Typography>
          {passFail.map((m) => <MetricRow key={m.key} m={m} />)}
        </>
      )}

      {scores.length > 0 && (
        <>
          <Divider sx={{ my: 1, borderColor: 'rgba(255,255,255,0.15)' }} />
          <Typography variant="caption" sx={{ display: 'block', mb: 0.75, fontWeight: 700, opacity: 0.7, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 10 }}>
            Scores
          </Typography>
          {scores.map((m) => <MetricRow key={m.key} m={m} />)}
        </>
      )}

      {unknown.length > 0 && (
        <>
          <Divider sx={{ my: 1, borderColor: 'rgba(255,255,255,0.15)' }} />
          <Typography variant="caption" sx={{ display: 'block', mb: 0.75, fontWeight: 700, opacity: 0.5, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 10 }}>
            ⚠ Unknown scale (excluded)
          </Typography>
          {unknown.map((m) => (
            <Box key={m.key} sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
              <Typography variant="caption" sx={{ opacity: 0.6, textTransform: 'capitalize' }}>
                {m.key.replace(/_/g, ' ')}
              </Typography>
              <Typography variant="caption" sx={{ opacity: 0.6 }}>
                {m.raw !== null ? String(m.raw) : '—'}
              </Typography>
            </Box>
          ))}
        </>
      )}

      {sims.length > 1 && (
        <>
          <Divider sx={{ my: 1, borderColor: 'rgba(255,255,255,0.15)' }} />
          <Typography variant="caption" sx={{ display: 'block', mb: 0.5, fontWeight: 700, opacity: 0.7, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 10 }}>
            All {sims.length} runs
          </Typography>
          {sims.map((s, i) => {
            const sc = computeAggregateScore(s.model_metrics, checkMetaMap);
            return (
              <Typography key={s.id} variant="caption" sx={{ display: 'block', opacity: i === 0 ? 1 : 0.65 }}>
                {i === 0 ? 'Latest' : `Run ${sims.length - i}`}:{' '}
                <Box component="span" fontWeight={600} sx={{ color: scoreColor(sc) }}>
                  {sc !== null ? `${(sc * 100).toFixed(1)}%` : '—'}
                </Box>
                {i === 0 && <Box component="span" sx={{ opacity: 0.5 }}> (shown)</Box>}
              </Typography>
            );
          })}
        </>
      )}

      {opMeta && (
        <>
          <Divider sx={{ my: 1, borderColor: 'rgba(255,255,255,0.15)' }} />
          <Typography variant="caption" sx={{ opacity: 0.65, display: 'block' }}>
            {opMeta.total_cost != null && `Cost: $${Number(opMeta.total_cost).toFixed(4)}`}
            {opMeta.total_cost != null && opMeta.average_latency && ' · '}
            {opMeta.average_latency && `Latency: ${(opMeta.average_latency / 1000).toFixed(1)}s`}
          </Typography>
        </>
      )}
    </Box>
  );
}

// ─── ScoreCell ────────────────────────────────────────────────────────────────

function ScoreCell({
  sims,
  prevVersionSims,
  onSimClick,
  isFirstInGroup,
  checkMetaMap,
}: {
  sims: Simulation[];
  prevVersionSims: Simulation[];
  onSimClick: (sim: Simulation) => void;
  isFirstInGroup: boolean;
  checkMetaMap: Record<string, CheckMeta>;
}) {
  const score = sims.length > 0 ? computeAggregateScore(sims[0].model_metrics, checkMetaMap) : null;
  const prevScore = prevVersionSims.length > 0 ? computeAggregateScore(prevVersionSims[0].model_metrics, checkMetaMap) : null;
  const delta = score !== null && prevScore !== null ? score - prevScore : null;

  const cellSx = {
    textAlign: 'center' as const,
    borderLeft: isFirstInGroup ? '2px solid' : undefined,
    borderColor: 'divider',
    py: 1.5,
    px: 1,
    minWidth: 120,
  };

  if (sims.length === 0) {
    return (
      <TableCell sx={cellSx}>
        <Typography variant="caption" color="text.disabled">—</Typography>
      </TableCell>
    );
  }

  return (
    <TableCell sx={cellSx}>
      <Tooltip title={<ScoreCellTooltip sims={sims} checkMetaMap={checkMetaMap} />} placement="right" arrow>
        <Box sx={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, cursor: 'default' }}>
          <Chip
            label={score !== null ? `${(score * 100).toFixed(1)}%` : '—'}
            size="small"
            onClick={(e) => { e.stopPropagation(); onSimClick(sims[0]); }}
            sx={{
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
              color: scoreColor(score),
              bgcolor: score === null ? 'grey.100'
                : score >= 0.75 ? 'success.50'
                : score >= 0.5 ? 'warning.50'
                : 'error.50',
              border: '1px solid',
              borderColor: scoreColor(score),
              '&:hover': { opacity: 0.85 },
            }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 18 }}>
            {delta !== null && (
              <Typography
                variant="caption"
                sx={{ fontWeight: 700, fontSize: 11, color: delta >= 0 ? 'success.main' : 'error.main', lineHeight: 1 }}
              >
                {delta >= 0 ? '↑' : '↓'}{Math.abs(delta * 100).toFixed(1)}%
              </Typography>
            )}
            {sims.length > 1 && (
              <Chip
                label={sims.length}
                size="small"
                variant="outlined"
                sx={{ height: 16, fontSize: 10, px: 0, '& .MuiChip-label': { px: 0.75 } }}
              />
            )}
          </Box>
        </Box>
      </Tooltip>
    </TableCell>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SimulationsTableProps {
  token: string;
  scenarios: Scenario[];
  targets: Target[];
  drivers: Driver[];
  checks: Check[];
  onSimClick: (sim: Simulation) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SimulationsTable({
  token,
  scenarios,
  targets,
  drivers,
  checks,
  onSimClick,
}: SimulationsTableProps) {
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [selectedTargetNames, setSelectedTargetNames] = useState<string[]>([]);
  const [selectedScenarios, setSelectedScenarios] = useState<Scenario[]>([]);
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [simsLoading, setSimsLoading] = useState(false);
  const [simsError, setSimsError] = useState<string | null>(null);

  // Fetch simulations whenever the selected driver changes
  useEffect(() => {
    if (!selectedDriver) {
      setSimulations([]);
      return;
    }
    setSimsLoading(true);
    setSimsError(null);
    setSelectedScenarios([]);
    setSelectedTargetNames([]);
    listSimulations(token, selectedDriver.id)
      .then(setSimulations)
      .catch((err) => setSimsError(err.message || 'Failed to load simulations.'))
      .finally(() => setSimsLoading(false));
  }, [token, selectedDriver]);

  const checkMetaMap = useMemo(() => buildCheckMetaMap(checks), [checks]);

  // Scenario and target IDs that have at least one FINISHED simulation for this driver
  const finishedSims = useMemo(
    () => simulations.filter((s) => s.status === 'FINISHED'),
    [simulations]
  );
  const activeScenarioIds = useMemo(
    () => new Set(finishedSims.map((s) => s.scenario_set_id).filter(Boolean) as string[]),
    [finishedSims]
  );
  const activeTargetIds = useMemo(
    () => new Set(finishedSims.map((s) => s.mut_id).filter(Boolean) as string[]),
    [finishedSims]
  );

  // Unique target names for the multiselect — only targets that have simulations for this driver
  const targetNameOptions = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const t of targets) {
      if (activeTargetIds.has(t.id) && !seen.has(t.name)) {
        seen.add(t.name);
        names.push(t.name);
      }
    }
    return names.sort();
  }, [targets, activeTargetIds]);

  // Scenarios sorted alphabetically — only ones that have simulations for this driver
  const sortedScenarioOptions = useMemo(
    () =>
      scenarios
        .filter((s) => activeScenarioIds.has(s.scenario_id))
        .sort((a, b) => (a.name || a.scenario_id).localeCompare(b.name || b.scenario_id)),
    [scenarios, activeScenarioIds]
  );

  // Group all targets by name, sort each group descending by time_created
  const targetVersionGroups = useMemo(() => {
    const groups: Record<string, Target[]> = {};
    for (const t of targets) {
      if (!groups[t.name]) groups[t.name] = [];
      groups[t.name].push(t);
    }
    for (const name in groups) {
      groups[name].sort(
        (a, b) =>
          new Date(b.time_created || 0).getTime() -
          new Date(a.time_created || 0).getTime()
      );
    }
    return groups;
  }, [targets]);

  // For display: only selected target names, latest 3 versions each, with version labels
  const displayVersionGroups = useMemo(() => {
    const result: Record<string, { target: Target; versionLabel: string }[]> = {};
    for (const name of selectedTargetNames) {
      const versions = targetVersionGroups[name];
      if (!versions) continue;
      const total = versions.length;
      result[name] = versions.slice(0, 3).map((t, i) => ({
        target: t,
        versionLabel: `v${total - i}`,
      }));
    }
    return result;
  }, [selectedTargetNames, targetVersionGroups]);

  // matrix[scenario_id][target_id] = Simulation[] sorted by start_time desc
  const tableMatrix = useMemo(() => {
    if (!selectedDriver) return {};
    const sims = finishedSims;
    const matrix: Record<string, Record<string, Simulation[]>> = {};
    for (const sim of sims) {
      const scen = sim.scenario_set_id;
      const targ = sim.mut_id;
      if (!scen || !targ) continue;
      if (!matrix[scen]) matrix[scen] = {};
      if (!matrix[scen][targ]) matrix[scen][targ] = [];
      matrix[scen][targ].push(sim);
    }
    for (const scenSims of Object.values(matrix)) {
      for (const arr of Object.values(scenSims)) {
        arr.sort(
          (a, b) =>
            new Date(b.start_time || 0).getTime() -
            new Date(a.start_time || 0).getTime()
        );
      }
    }
    return matrix;
  }, [finishedSims, selectedDriver]);

  // Rows: only selected scenarios, sorted alphabetically
  const activeScenarios = useMemo(
    () => [...selectedScenarios].sort((a, b) => (a.name || a.scenario_id).localeCompare(b.name || b.scenario_id)),
    [selectedScenarios]
  );

  const totalCols = useMemo(
    () => 1 + Object.values(displayVersionGroups).reduce((sum, vs) => sum + vs.length, 0),
    [displayVersionGroups]
  );

  const hasDriver = selectedDriver !== null;
  const hasTargets = selectedTargetNames.length > 0;
  const hasScenarios = selectedScenarios.length > 0;

  return (
    <Box>
      {/* Filters */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Driver — single-select, required */}
          <Autocomplete
            size="small"
            options={drivers}
            getOptionLabel={(option) => option.name || option.id}
            value={selectedDriver}
            onChange={(_, newValue) => setSelectedDriver(newValue)}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Driver"
                placeholder="Select a driver..."
                required
              />
            )}
            sx={{ minWidth: 280 }}
          />

          {/* Scenarios — multiselect with checkboxes, enabled after driver selected */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: 1, minWidth: 320 }}>
            <Autocomplete
            multiple
            disableCloseOnSelect
            size="small"
            options={sortedScenarioOptions}
            getOptionLabel={(option) => option.name || option.scenario_id}
            value={selectedScenarios}
            onChange={(_, newValue) => setSelectedScenarios(newValue)}
            isOptionEqualToValue={(option, value) => option.scenario_id === value.scenario_id}
            disabled={!hasDriver}
            renderOption={(props, option, { selected }) => {
              const { key, ...liProps } = props as any;
              return (
                <li key={key} {...liProps}>
                  <Checkbox
                    icon={<CheckBoxOutlineBlankIcon fontSize="small" />}
                    checkedIcon={<CheckBoxIcon fontSize="small" />}
                    checked={selected}
                    size="small"
                    sx={{ mr: 1, p: 0 }}
                  />
                  <ListItemText primary={option.name || option.scenario_id} primaryTypographyProps={{ variant: 'body2' }} />
                </li>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Scenarios"
                placeholder={selectedScenarios.length === 0 ? 'Select scenarios...' : ''}
              />
            )}
            renderTags={(value, getTagProps) =>
              value.map((s, index) => {
                const { key, ...tagProps } = getTagProps({ index });
                return <Chip key={key} label={s.name || s.scenario_id} size="small" {...tagProps} />;
              })
            }
            sx={{ width: '100%' }}
            />
            <Button
              size="small"
              disabled={!hasDriver || sortedScenarioOptions.length === 0}
              onClick={() => setSelectedScenarios(sortedScenarioOptions)}
              sx={{ alignSelf: 'flex-start', fontSize: 11 }}
            >
              Select all ({sortedScenarioOptions.length})
            </Button>
          </Box>

          {/* Targets — multiselect with checkboxes, enabled after driver selected */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: 1, minWidth: 320 }}>
          <Autocomplete
            multiple
            disableCloseOnSelect
            size="small"
            options={targetNameOptions}
            value={selectedTargetNames}
            onChange={(_, newValue) => setSelectedTargetNames(newValue)}
            disabled={!hasDriver}
            renderOption={(props, option, { selected }) => {
              const { key, ...liProps } = props as any;
              return (
                <li key={key} {...liProps}>
                  <Checkbox
                    icon={<CheckBoxOutlineBlankIcon fontSize="small" />}
                    checkedIcon={<CheckBoxIcon fontSize="small" />}
                    checked={selected}
                    size="small"
                    sx={{ mr: 1, p: 0 }}
                  />
                  <ListItemText primary={option} primaryTypographyProps={{ variant: 'body2' }} />
                </li>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Targets"
                placeholder={selectedTargetNames.length === 0 ? 'Select targets...' : ''}
              />
            )}
            renderTags={(value, getTagProps) =>
              value.map((name, index) => {
                const { key, ...tagProps } = getTagProps({ index });
                return <Chip key={key} label={name} size="small" {...tagProps} />;
              })
            }
            sx={{ width: '100%' }}
          />
            <Button
              size="small"
              disabled={!hasDriver || targetNameOptions.length === 0}
              onClick={() => setSelectedTargetNames(targetNameOptions)}
              sx={{ alignSelf: 'flex-start', fontSize: 11 }}
            >
              Select all ({targetNameOptions.length})
            </Button>
          </Box>
        </Box>
      </Paper>

      {/* Empty state: no driver selected */}
      {!hasDriver && (
        <Box sx={{ textAlign: 'center', py: 10 }}>
          <Typography color="text.secondary">
            Select a driver to get started.
          </Typography>
        </Box>
      )}

      {/* Loading simulations */}
      {hasDriver && simsLoading && (
        <Box sx={{ textAlign: 'center', py: 10 }}>
          <Typography color="text.secondary">Loading simulations...</Typography>
        </Box>
      )}

      {/* Error loading simulations */}
      {hasDriver && !simsLoading && simsError && (
        <Box sx={{ textAlign: 'center', py: 10 }}>
          <Typography color="error.main">{simsError}</Typography>
        </Box>
      )}

      {/* Empty state: driver selected but nothing else */}
      {hasDriver && !simsLoading && !simsError && !hasScenarios && !hasTargets && (
        <Box sx={{ textAlign: 'center', py: 10 }}>
          <Typography color="text.secondary">
            Now select scenarios and targets to build the comparison table.
          </Typography>
        </Box>
      )}

      {/* Matrix table — only render once driver is loaded + at least one of scenarios/targets is set */}
      {hasDriver && !simsLoading && !simsError && (hasScenarios || hasTargets) && (
        <TableContainer
          component={Paper}
          sx={{
            overflowX: 'auto',
            '&::-webkit-scrollbar': { height: 6 },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': { background: 'rgba(0,0,0,0.15)', borderRadius: 3 },
            '&::-webkit-scrollbar-thumb:hover': { background: 'rgba(0,0,0,0.3)' },
          }}
        >
          <Table size="small" sx={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <TableHead>
              {/* Row 1: Target group names */}
              <TableRow>
                <TableCell
                  rowSpan={hasTargets ? 2 : 1}
                  sx={{
                    position: 'sticky', left: 0, zIndex: 3,
                    bgcolor: 'background.paper',
                    fontWeight: 700, fontSize: 13,
                    minWidth: 200, maxWidth: 280,
                    borderRight: '2px solid', borderColor: 'divider',
                    verticalAlign: 'middle',
                  }}
                >
                  Scenario
                </TableCell>
                {!hasTargets ? (
                  <TableCell sx={{ color: 'text.disabled', fontStyle: 'italic', fontSize: 13 }}>
                    Select targets above to populate columns
                  </TableCell>
                ) : (
                  Object.entries(displayVersionGroups).map(([name, versions]) => (
                    <TableCell
                      key={name}
                      colSpan={versions.length}
                      align="center"
                      sx={{
                        fontWeight: 700, fontSize: 12,
                        borderLeft: '2px solid', borderColor: 'divider',
                        bgcolor: 'grey.50', py: 1,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                      title={name}
                    >
                      {name}
                    </TableCell>
                  ))
                )}
              </TableRow>

              {/* Row 2: Version labels (only when targets selected) */}
              {hasTargets && (
                <TableRow>
                  {Object.entries(displayVersionGroups).flatMap(([, versions]) =>
                    versions.map((v, vi) => (
                      <TableCell
                        key={v.target.id}
                        align="center"
                        sx={{
                          fontWeight: 600, fontSize: 11, py: 0.75,
                          color: vi === 0 ? 'primary.main' : 'text.secondary',
                          borderLeft: vi === 0 ? '2px solid' : undefined,
                          borderColor: 'divider',
                          minWidth: 120,
                          bgcolor: vi === 0 ? 'primary.50' : 'grey.50',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {v.versionLabel}
                        {vi === 0 && (
                          <Box component="span" sx={{ ml: 0.5, color: 'primary.light', fontSize: 9 }}>
                            (latest)
                          </Box>
                        )}
                      </TableCell>
                    ))
                  )}
                </TableRow>
              )}
            </TableHead>

            <TableBody>
              {!hasScenarios ? (
                <TableRow>
                  <TableCell colSpan={totalCols} align="center" sx={{ py: 6, color: 'text.secondary', fontStyle: 'italic' }}>
                    Select scenarios above to populate rows.
                  </TableCell>
                </TableRow>
              ) : (
                activeScenarios.map((scenario) => (
                  <TableRow key={scenario.scenario_id} sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
                    <TableCell
                      sx={{
                        position: 'sticky', left: 0, zIndex: 1,
                        bgcolor: 'background.paper',
                        fontSize: 13, fontWeight: 500,
                        maxWidth: 280,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        borderRight: '2px solid', borderColor: 'divider',
                      }}
                      title={scenario.name || scenario.scenario_id}
                    >
                      {scenario.name || scenario.scenario_id}
                    </TableCell>

                    {!hasTargets ? (
                      <TableCell />
                    ) : (
                      Object.entries(displayVersionGroups).flatMap(([, versions]) =>
                        versions.map((v, vi) => {
                          const cellSims = tableMatrix[scenario.scenario_id]?.[v.target.id] ?? [];
                          const prevVersionSims =
                            vi < versions.length - 1
                              ? (tableMatrix[scenario.scenario_id]?.[versions[vi + 1].target.id] ?? [])
                              : [];
                          return (
                            <ScoreCell
                              key={v.target.id}
                              sims={cellSims}
                              prevVersionSims={prevVersionSims}
                              onSimClick={onSimClick}
                              isFirstInGroup={vi === 0}
                              checkMetaMap={checkMetaMap}
                            />
                          );
                        })
                      )
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
