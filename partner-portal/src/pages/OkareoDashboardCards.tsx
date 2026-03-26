import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import TrackChangesIcon from '@mui/icons-material/TrackChanges';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import ListAltIcon from '@mui/icons-material/ListAlt';
import { Driver, Scenario, Simulation, Target } from '../services/okareoService';

function formatDate(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SimulationsCardsProps {
  visibleSims: Simulation[];
  filtered: Simulation[];
  simulations: Simulation[];
  hasMore: boolean;
  sentinelRef: React.RefObject<HTMLDivElement>;
  search: string;
  onSearchChange: (value: string) => void;
  targetFilter: string;
  onTargetFilterChange: (id: string) => void;
  driverFilter: string;
  onDriverFilterChange: (id: string) => void;
  scenarioFilter: string;
  onScenarioFilterChange: (id: string) => void;
  targets: Target[];
  drivers: Driver[];
  scenarios: Scenario[];
  targetMap: Record<string, string>;
  driverMap: Record<string, string>;
  scenarioMap: Record<string, string>;
  selected: string[];
  onToggleSelect: (id: string) => void;
  onCompare: () => void;
  compareLoading: boolean;
  hasFilters: boolean;
  onClearFilters: () => void;
  onSimClick: (sim: Simulation) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SimulationsCards({
  visibleSims,
  filtered,
  simulations,
  hasMore,
  sentinelRef,
  search,
  onSearchChange,
  targetFilter,
  onTargetFilterChange,
  driverFilter,
  onDriverFilterChange,
  scenarioFilter,
  onScenarioFilterChange,
  targets,
  drivers,
  scenarios,
  targetMap,
  driverMap,
  scenarioMap,
  selected,
  onToggleSelect,
  onCompare,
  compareLoading,
  hasFilters,
  onClearFilters,
  onSimClick,
}: SimulationsCardsProps) {
  return (
    <Box>
      {/* Search & Filters */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack spacing={2}>
          {/* Row 1: Main Search & Filters */}
          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
            <TextField
              size="small"
              placeholder="Search by simulation name..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              sx={{ flex: 1, minWidth: 320, WebkitFlexBasis: 320 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />

            <Tooltip title={targets.find((t) => t.id === targetFilter)?.name || ''} disableHoverListener={!targetFilter}>
              <Autocomplete
                size="small"
                options={targets}
                getOptionLabel={(option) => option.name || option.id}
                value={targets.find((t) => t.id === targetFilter) || null}
                onChange={(_, newValue) => onTargetFilterChange(newValue?.id || '')}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Target"
                    placeholder="Search target..."
                    InputProps={{
                      ...params.InputProps,
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" color="action" />
                        </InputAdornment>
                      ),
                    }}
                  />
                )}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                sx={{ width: 280 }}
              />
            </Tooltip>

            <Tooltip title={drivers.find((d) => d.id === driverFilter)?.name || ''} disableHoverListener={!driverFilter}>
              <Autocomplete
                size="small"
                options={drivers}
                getOptionLabel={(option) => option.name || option.id}
                value={drivers.find((d) => d.id === driverFilter) || null}
                onChange={(_, newValue) => onDriverFilterChange(newValue?.id || '')}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Driver"
                    placeholder="Search driver..."
                    InputProps={{
                      ...params.InputProps,
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" color="action" />
                        </InputAdornment>
                      ),
                    }}
                  />
                )}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                sx={{ width: 280 }}
              />
            </Tooltip>

            <Tooltip title={scenarios.find((s) => s.scenario_id === scenarioFilter)?.name || scenarios.find((s) => s.scenario_id === scenarioFilter)?.scenario_id || ''} disableHoverListener={!scenarioFilter}>
              <Autocomplete
                size="small"
                options={scenarios}
                getOptionLabel={(option) => option.name || option.scenario_id}
                value={scenarios.find((s) => s.scenario_id === scenarioFilter) || null}
                onChange={(_, newValue) => onScenarioFilterChange(newValue?.scenario_id || '')}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Scenario"
                    placeholder="Search scenario..."
                    InputProps={{
                      ...params.InputProps,
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" color="action" />
                        </InputAdornment>
                      ),
                    }}
                  />
                )}
                isOptionEqualToValue={(option, value) => option.scenario_id === value.scenario_id}
                sx={{ width: 280 }}
              />
            </Tooltip>

            {hasFilters && (
              <Tooltip title="Clear filters">
                <IconButton size="small" onClick={onClearFilters}>
                  <ClearIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>

          {/* Row 2: Actions */}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              disabled={selected.length < 2 || compareLoading}
              onClick={onCompare}
              startIcon={compareLoading ? <CircularProgress size={16} /> : undefined}
            >
              Compare Selected ({selected.length})
            </Button>
          </Box>
        </Stack>
      </Paper>

      {/* Count line */}
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
        Showing {visibleSims.length} of {filtered.length} simulations
        {filtered.length !== simulations.length && ` (${simulations.length} total)`}
      </Typography>

      {/* Card grid */}
      {filtered.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography color="text.secondary">
            {hasFilters ? 'No simulations match your filters.' : 'No simulations found.'}
          </Typography>
        </Box>
      ) : (
        <>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 2,
            }}
          >
            {visibleSims.map((sim) => {
              const isSelected = selected.includes(sim.id);
              const statusColor =
                sim.status === 'FINISHED' ? 'success'
                : sim.status === 'RUNNING' ? 'info'
                : sim.status === 'FAILED' ? 'error'
                : 'default';
              const borderColor =
                sim.status === 'FINISHED' ? 'success.main'
                : sim.status === 'RUNNING' ? 'info.main'
                : sim.status === 'FAILED' ? 'error.main'
                : 'grey.400';

              return (
                <Card
                  key={sim.id}
                  onClick={() => onSimClick(sim)}
                  sx={{
                    cursor: 'pointer',
                    borderLeft: '4px solid',
                    borderColor: isSelected ? 'primary.main' : borderColor,
                    boxShadow: isSelected ? 4 : 1,
                    outline: isSelected ? '2px solid' : 'none',
                    outlineColor: 'primary.main',
                    transition: 'box-shadow 0.15s, border-color 0.15s',
                    '&:hover': { boxShadow: 3 },
                    position: 'relative',
                  }}
                >
                  <Box
                    sx={{ position: 'absolute', top: 8, right: 8 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={isSelected}
                      onChange={() => onToggleSelect(sim.id)}
                      size="small"
                    />
                  </Box>

                  <CardContent sx={{ pb: '12px !important' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                      <Chip label={sim.status || 'unknown'} size="small" color={statusColor} />
                    </Box>

                    <Typography
                      variant="subtitle1"
                      fontWeight={600}
                      sx={{ pr: 4, mb: 1.5, lineHeight: 1.3, wordBreak: 'break-word' }}
                    >
                      {sim.name || sim.id}
                    </Typography>

                    <Divider sx={{ mb: 1.5 }} />

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <TrackChangesIcon sx={{ fontSize: 14, color: 'text.disabled', flexShrink: 0 }} />
                        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>Target:</Typography>
                        <Typography variant="caption" noWrap title={sim.mut_id ? (targetMap[sim.mut_id] || sim.mut_id) : '—'}>
                          {sim.mut_id ? (targetMap[sim.mut_id] || sim.mut_id) : '—'}
                        </Typography>
                      </Box>

                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <SmartToyIcon sx={{ fontSize: 14, color: 'text.disabled', flexShrink: 0 }} />
                        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>Driver:</Typography>
                        <Typography variant="caption" noWrap title={sim.driver_id ? (driverMap[sim.driver_id] || sim.driver_id) : '—'}>
                          {sim.driver_id ? (driverMap[sim.driver_id] || sim.driver_id) : '—'}
                        </Typography>
                      </Box>

                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <ListAltIcon sx={{ fontSize: 14, color: 'text.disabled', flexShrink: 0 }} />
                        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>Scenario:</Typography>
                        <Typography
                          variant="caption"
                          noWrap
                          title={sim.scenario_set_id ? (scenarioMap[sim.scenario_set_id] || sim.scenario_set_id) : '—'}
                        >
                          {sim.scenario_set_id ? (scenarioMap[sim.scenario_set_id] || sim.scenario_set_id) : '—'}
                        </Typography>
                      </Box>

                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <CalendarTodayIcon sx={{ fontSize: 14, color: 'text.disabled', flexShrink: 0 }} />
                        <Typography variant="caption" color="text.secondary">
                          {formatDate(sim.start_time)}
                        </Typography>
                      </Box>
                    </Box>

                    {sim.tags && sim.tags.length > 0 && (
                      <Box sx={{ mt: 1.5, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                        {sim.tags.slice(0, 3).map((tag) => (
                          <Chip key={tag} label={tag} size="small" variant="outlined" />
                        ))}
                      </Box>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </Box>

          {/* Infinite scroll sentinel */}
          <Box
            ref={sentinelRef}
            sx={{ display: 'flex', justifyContent: 'center', py: 3, mt: 1 }}
          >
            {hasMore ? (
              <CircularProgress size={24} />
            ) : (
              <Typography variant="caption" color="text.secondary">
                All {filtered.length} simulations loaded
              </Typography>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
