import { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Alert,
  CircularProgress,
  Chip,
  Grid,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import {
  TrendingUp as TrendingUpIcon,
  TrendingDown as TrendingDownIcon,
  ArrowForward as ArrowForwardIcon,
  LinkOff as LinkOffIcon,
  VolumeUp as VolumeUpIcon,
  Warning as WarningIcon,
  ErrorOutline as ErrorOutlineIcon,
  Info as InfoIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

Chart.register(...registerables);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FunnelSource {
  name: string;
  count: number;
  status: 'ok' | 'unavailable' | 'error';
}

interface FunnelStage {
  name: string;
  count: number;
  previousCount: number;
  conversionRate: number;
  sources: FunnelSource[];
  status: 'ok' | 'unavailable' | 'error';
}

interface ConstraintAnalysis {
  stage: string;
  conversionRate: number;
  type: 'more' | 'metrics' | 'leads' | 'sales' | 'ltv' | 'cashflow';
  suggestion: string;
}

interface ChannelPipeline {
  channel: 'seo' | 'linkedin' | 'outbound' | 'paid_ads';
  displayName: string;
  stages: FunnelStage[];
  constraint: ConstraintAnalysis | null;
}

interface ChannelComparison {
  channel: string;
  leads: number;
  conversionPercent: number;
  demos: number;
  closePercent: number;
  paid: number;
  cac: number;
}

interface FunnelMetricsResponse {
  channels: ChannelPipeline[];
  comparison: ChannelComparison[];
  aggregate: {
    totalLeads: number;
    totalPaid: number;
    overallConstraint: ConstraintAnalysis | null;
  };
  period: { start: string; end: string };
}

type PeriodOption = '7d' | '30d' | '90d' | 'YTD';
type ChannelTab = 'overview' | 'seo' | 'linkedin' | 'outbound' | 'paid_ads';

type SortKey = keyof ChannelComparison;
type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const nf = new Intl.NumberFormat('en-US');

function formatNumber(n: number): string {
  return nf.format(n);
}

function formatCurrency(n: number): string {
  return n === 0 ? '$0' : `$${nf.format(n)}`;
}

function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

function getChangePercent(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function getConversionColor(rate: number): 'success' | 'warning' | 'error' {
  if (rate > 10) return 'success';
  if (rate >= 5) return 'warning';
  return 'error';
}

function getBarColor(index: number, total: number, status: string): string {
  if (status === 'unavailable') return '#bdbdbd';
  const ratio = total > 1 ? index / (total - 1) : 0;
  const r = Math.round(25 + (76 - 25) * ratio);
  const g = Math.round(118 + (175 - 118) * ratio);
  const b = Math.round(210 + (80 - 210) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

// ---------------------------------------------------------------------------
// Constraint Alert
// ---------------------------------------------------------------------------
function ConstraintAlert({
  constraint,
  prefix,
}: {
  constraint: ConstraintAnalysis;
  prefix?: string;
}) {
  const config: Record<
    ConstraintAnalysis['type'],
    { severity: 'info' | 'warning' | 'error'; color: string; icon: React.ReactNode; label: string }
  > = {
    more: {
      severity: 'info',
      color: '#e3f2fd',
      icon: <VolumeUpIcon />,
      label: 'VOLUME',
    },
    metrics: {
      severity: 'info',
      color: '#f5f5f5',
      icon: <WarningIcon />,
      label: 'DATA',
    },
    leads: {
      severity: 'warning',
      color: '#fff3e0',
      icon: <WarningIcon />,
      label: 'LEADS',
    },
    sales: {
      severity: 'error',
      color: '#ffebee',
      icon: <ErrorOutlineIcon />,
      label: 'SALES',
    },
    ltv: {
      severity: 'info',
      color: '#f3e5f5',
      icon: <InfoIcon />,
      label: 'LTV',
    },
    cashflow: {
      severity: 'warning',
      color: '#fff8e1',
      icon: <WarningIcon />,
      label: 'CASHFLOW',
    },
  };

  const c = config[constraint.type];
  const title = prefix ? `${prefix} CONSTRAINT` : 'YOUR #1 CONSTRAINT';

  return (
    <Alert
      severity={c.severity}
      icon={c.icon}
      sx={{
        mb: 2,
        backgroundColor: c.color,
        '& .MuiAlert-icon': { alignItems: 'center' },
      }}
    >
      <Typography variant="subtitle2" component="span" sx={{ fontWeight: 700 }}>
        {title}: {c.label}
      </Typography>
      {' '}
      &mdash;{' '}
      <Typography variant="body2" component="span">
        {constraint.suggestion}
      </Typography>
      {constraint.stage && (
        <Typography variant="caption" component="span" color="text.secondary" sx={{ ml: 1 }}>
          (at {constraint.stage}, {formatPercent(constraint.conversionRate)} conv.)
        </Typography>
      )}
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Funnel Bar Chart
// ---------------------------------------------------------------------------
function FunnelBarChart({
  stages,
  constraintStage,
  title,
}: {
  stages: FunnelStage[];
  constraintStage?: string;
  title?: string;
}) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (!chartRef.current || stages.length === 0) return;

    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    const labels = stages.map((s) => s.name);
    const data = stages.map((s) => s.count);
    const backgroundColors = stages.map((s, i) => {
      if (s.status === 'unavailable') return '#bdbdbd';
      if (constraintStage && s.name === constraintStage) return '#ef5350';
      return getBarColor(i, stages.length, s.status);
    });
    const borderColors = stages.map((s) =>
      s.status === 'unavailable' ? '#9e9e9e' : 'transparent'
    );

    const config: ChartConfiguration = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Count',
            data,
            backgroundColor: backgroundColors,
            borderColor: borderColors,
            borderWidth: stages.map((s) => (s.status === 'unavailable' ? 2 : 0)),
            borderSkipped: false,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: !!title, text: title ?? '' },
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const stage = stages[ctx.dataIndex];
                if (stage.status === 'unavailable') return 'Data not connected';
                return `Count: ${formatNumber(ctx.parsed.x)}`;
              },
              afterLabel: (ctx) => {
                const stage = stages[ctx.dataIndex];
                if (stage.status === 'unavailable' || ctx.dataIndex === 0) return '';
                return `Conversion from prev: ${formatPercent(stage.conversionRate)}`;
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: {
              callback: (value) => formatNumber(Number(value)),
            },
          },
          y: {
            ticks: {
              font: { weight: 'bold' as const },
            },
          },
        },
      },
    };

    chartInstance.current = new Chart(chartRef.current, config);

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [stages, constraintStage, title]);

  return (
    <Paper sx={{ p: 3, mb: 2 }}>
      <Box sx={{ position: 'relative', height: Math.max(250, stages.length * 50) }}>
        <canvas ref={chartRef} />
      </Box>
      {/* Conversion rate annotations between stages */}
      <Box sx={{ mt: 2 }}>
        {stages.map((stage, i) => {
          if (i === 0) return null;
          const prev = stages[i - 1];
          if (stage.status === 'unavailable' || prev.status === 'unavailable') return null;
          const color = getConversionColor(stage.conversionRate);
          return (
            <Box
              key={stage.name}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                mr: 2,
                mb: 0.5,
              }}
            >
              <Typography variant="caption" color="text.secondary">
                {prev.name}
              </Typography>
              <ArrowForwardIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                {stage.name}:
              </Typography>
              <Chip
                label={formatPercent(stage.conversionRate)}
                size="small"
                color={color}
                variant="outlined"
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Stage Detail Card
// ---------------------------------------------------------------------------
function StageCard({ stage }: { stage: FunnelStage }) {
  const changePct = getChangePercent(stage.count, stage.previousCount);
  const isPositive = changePct >= 0;
  const isUnavailable = stage.status === 'unavailable';

  return (
    <Paper
      sx={{
        p: 2.5,
        height: '100%',
        ...(isUnavailable && {
          borderStyle: 'dashed',
          borderColor: 'grey.400',
          borderWidth: 1,
          backgroundColor: 'grey.50',
          opacity: 0.7,
        }),
      }}
      variant="outlined"
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
        <Typography variant="subtitle2" color="text.secondary">
          {stage.name}
        </Typography>
        {isUnavailable && (
          <Chip
            icon={<LinkOffIcon sx={{ fontSize: 14 }} />}
            label="Data not connected"
            size="small"
            color="default"
            variant="outlined"
            sx={{ fontSize: '0.7rem', height: 22 }}
          />
        )}
      </Box>

      <Typography
        variant="h4"
        sx={{ fontWeight: 700, mb: 0.5, color: isUnavailable ? 'text.disabled' : 'text.primary' }}
      >
        {isUnavailable ? '--' : formatNumber(stage.count)}
      </Typography>

      {!isUnavailable && stage.previousCount > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1.5 }}>
          {isPositive ? (
            <TrendingUpIcon fontSize="small" color="success" />
          ) : (
            <TrendingDownIcon fontSize="small" color="error" />
          )}
          <Chip
            label={`${isPositive ? '+' : ''}${changePct.toFixed(1)}%`}
            size="small"
            color={isPositive ? 'success' : 'error'}
            variant="outlined"
          />
          <Typography variant="caption" color="text.secondary">
            vs prev period
          </Typography>
        </Box>
      )}

      {!isUnavailable && stage.sources.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Sources
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {stage.sources.map((src) => (
              <Chip
                key={src.name}
                label={`${src.name}: ${formatNumber(src.count)}`}
                size="small"
                variant="outlined"
                color={src.status === 'ok' ? 'default' : 'warning'}
                sx={{ fontSize: '0.7rem', height: 22 }}
              />
            ))}
          </Box>
        </Box>
      )}
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Channel Comparison Table
// ---------------------------------------------------------------------------
function ChannelComparisonTable({
  comparison,
  onChannelClick,
}: {
  comparison: ChannelComparison[];
  onChannelClick: (channel: ChannelTab) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('leads');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sorted = [...comparison].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    }
    return 0;
  });

  // Find best/worst for highlighting
  const bestCloseIdx = comparison.reduce(
    (best, row, i) => (row.closePercent > comparison[best].closePercent ? i : best),
    0
  );
  const worstCacIdx = comparison.reduce(
    (worst, row, i) => (row.cac > comparison[worst].cac ? i : worst),
    0
  );
  const bestCloseChannel = comparison[bestCloseIdx]?.channel;
  const worstCacChannel = comparison[worstCacIdx]?.channel;

  const channelToTab = (ch: string): ChannelTab => {
    const map: Record<string, ChannelTab> = {
      SEO: 'seo',
      LinkedIn: 'linkedin',
      Outbound: 'outbound',
      'Paid Ads': 'paid_ads',
      seo: 'seo',
      linkedin: 'linkedin',
      outbound: 'outbound',
      paid_ads: 'paid_ads',
    };
    return map[ch] ?? 'overview';
  };

  const columns: { key: SortKey; label: string; format: (v: number) => string }[] = [
    { key: 'leads', label: 'Leads', format: formatNumber },
    { key: 'conversionPercent', label: 'Conv%', format: formatPercent },
    { key: 'demos', label: 'Demos', format: formatNumber },
    { key: 'closePercent', label: 'Close%', format: formatPercent },
    { key: 'paid', label: 'Paid', format: formatNumber },
    { key: 'cac', label: 'CAC', format: formatCurrency },
  ];

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5 }}>
        Channel Comparison
      </Typography>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>Channel</TableCell>
              {columns.map((col) => (
                <TableCell key={col.key} align="right" sx={{ fontWeight: 600 }}>
                  <TableSortLabel
                    active={sortKey === col.key}
                    direction={sortKey === col.key ? sortDir : 'desc'}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label}
                  </TableSortLabel>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.map((row) => {
              const isBestClose = row.channel === bestCloseChannel;
              const isWorstCac = row.channel === worstCacChannel && row.cac > 0;

              return (
                <TableRow key={row.channel} hover>
                  <TableCell>
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: 600,
                        cursor: 'pointer',
                        color: 'primary.main',
                        '&:hover': { textDecoration: 'underline' },
                      }}
                      onClick={() => onChannelClick(channelToTab(row.channel))}
                    >
                      {row.channel}
                    </Typography>
                  </TableCell>
                  {columns.map((col) => {
                    const val = row[col.key];
                    let cellSx: Record<string, string> = {};
                    if (col.key === 'closePercent' && isBestClose) {
                      cellSx = { color: 'success.main', fontWeight: '700' };
                    }
                    if (col.key === 'cac' && isWorstCac) {
                      cellSx = { color: 'error.main', fontWeight: '700' };
                    }
                    return (
                      <TableCell key={col.key} align="right" sx={cellSx}>
                        {typeof val === 'number' ? col.format(val) : val}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Overview View
// ---------------------------------------------------------------------------
function OverviewView({
  data,
  onChannelClick,
}: {
  data: FunnelMetricsResponse;
  onChannelClick: (channel: ChannelTab) => void;
}) {
  // Build aggregate stages from all channels
  const aggregateStages = buildAggregateStages(data.channels);

  return (
    <>
      {/* Constraint Alert */}
      {data.aggregate.overallConstraint && (
        <ConstraintAlert constraint={data.aggregate.overallConstraint} />
      )}

      {/* Channel Comparison Table */}
      {data.comparison.length > 0 && (
        <ChannelComparisonTable comparison={data.comparison} onChannelClick={onChannelClick} />
      )}

      {/* Aggregate Funnel Chart */}
      {aggregateStages.length > 0 && (
        <FunnelBarChart
          stages={aggregateStages}
          constraintStage={data.aggregate.overallConstraint?.stage}
          title="Aggregate Funnel (All Channels)"
        />
      )}
    </>
  );
}

/**
 * Combine stages across channels into aggregate totals.
 * Stages are merged by name; counts are summed.
 */
function buildAggregateStages(channels: ChannelPipeline[]): FunnelStage[] {
  const stageMap = new Map<string, FunnelStage>();
  const stageOrder: string[] = [];

  for (const channel of channels) {
    for (const stage of channel.stages) {
      const existing = stageMap.get(stage.name);
      if (existing) {
        existing.count += stage.count;
        existing.previousCount += stage.previousCount;
        // Merge sources
        for (const src of stage.sources) {
          const existingSrc = existing.sources.find((s) => s.name === src.name);
          if (existingSrc) {
            existingSrc.count += src.count;
          } else {
            existing.sources.push({ ...src });
          }
        }
        // If any channel has this stage available, mark as ok
        if (stage.status === 'ok') {
          existing.status = 'ok';
        }
      } else {
        stageMap.set(stage.name, {
          name: stage.name,
          count: stage.count,
          previousCount: stage.previousCount,
          conversionRate: 0, // recalculated below
          sources: stage.sources.map((s) => ({ ...s })),
          status: stage.status,
        });
        if (!stageOrder.includes(stage.name)) {
          stageOrder.push(stage.name);
        }
      }
    }
  }

  const ordered = stageOrder.map((name) => stageMap.get(name)!);

  // Recalculate conversion rates
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    if (prev.status !== 'unavailable' && curr.status !== 'unavailable' && prev.count > 0) {
      curr.conversionRate = (curr.count / prev.count) * 100;
    }
  }

  return ordered;
}

// ---------------------------------------------------------------------------
// Channel View
// ---------------------------------------------------------------------------
function ChannelView({ pipeline }: { pipeline: ChannelPipeline }) {
  return (
    <>
      {/* Channel Constraint Alert */}
      {pipeline.constraint && (
        <ConstraintAlert constraint={pipeline.constraint} prefix={pipeline.displayName} />
      )}

      {/* Channel Funnel Chart */}
      <FunnelBarChart
        stages={pipeline.stages}
        constraintStage={pipeline.constraint?.stage}
        title={`${pipeline.displayName} Funnel`}
      />

      {/* Stage Detail Cards */}
      <Grid container spacing={2}>
        {pipeline.stages.map((stage) => (
          <Grid item xs={12} sm={6} md={4} lg={3} key={stage.name}>
            <StageCard stage={stage} />
          </Grid>
        ))}
      </Grid>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function FunnelTab() {
  const { token } = useAuth();
  const [data, setData] = useState<FunnelMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<PeriodOption>('30d');
  const [activeChannel, setActiveChannel] = useState<ChannelTab>('overview');

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    const fetchFunnel = async () => {
      try {
        setLoading(true);
        setError('');
        const res = await axios.get(
          buildApiUrl(`/api/admin/funnel-metrics?period=${period}`),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!cancelled) {
          setData(res.data);
        }
      } catch (err: any) {
        if (cancelled) return;
        console.error('Error fetching funnel metrics:', err);
        if (err.response?.status === 404) {
          setError('Funnel metrics endpoint not available yet.');
        } else {
          setError('Failed to load funnel metrics.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchFunnel();

    return () => {
      cancelled = true;
    };
  }, [token, period]);

  const handlePeriodChange = (_: React.MouseEvent<HTMLElement>, newPeriod: PeriodOption | null) => {
    if (newPeriod) setPeriod(newPeriod);
  };

  const handleChannelChange = (_: React.SyntheticEvent, newValue: ChannelTab) => {
    setActiveChannel(newValue);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        {error}
      </Alert>
    );
  }

  if (!data || data.channels.length === 0) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        No funnel data available.
      </Alert>
    );
  }

  const selectedPipeline = data.channels.find((ch) => ch.channel === activeChannel);

  return (
    <Box>
      {/* Header + Period Selector */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">Marketing Funnel</Typography>
        <ToggleButtonGroup value={period} exclusive onChange={handlePeriodChange} size="small">
          <ToggleButton value="7d">7d</ToggleButton>
          <ToggleButton value="30d">30d</ToggleButton>
          <ToggleButton value="90d">90d</ToggleButton>
          <ToggleButton value="YTD">YTD</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Channel Tabs */}
      <Paper sx={{ mb: 2 }}>
        <Tabs
          value={activeChannel}
          onChange={handleChannelChange}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab label="Overview" value="overview" />
          {data.channels.map((ch) => (
            <Tab key={ch.channel} label={ch.displayName} value={ch.channel} />
          ))}
        </Tabs>
      </Paper>

      {/* Content */}
      {activeChannel === 'overview' ? (
        <OverviewView data={data} onChannelClick={setActiveChannel} />
      ) : selectedPipeline ? (
        <ChannelView pipeline={selectedPipeline} />
      ) : (
        <Alert severity="info" sx={{ mb: 2 }}>
          No data available for this channel.
        </Alert>
      )}
    </Box>
  );
}
