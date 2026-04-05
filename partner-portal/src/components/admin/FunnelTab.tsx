import { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Alert,
  CircularProgress,
  Chip,
  Grid,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import {
  TrendingUp as TrendingUpIcon,
  TrendingDown as TrendingDownIcon,
  ArrowForward as ArrowForwardIcon,
  LinkOff as LinkOffIcon,
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
  status: string;
}

interface FunnelStage {
  name: string;
  count: number;
  previousCount: number;
  conversionRate: number;
  sources: FunnelSource[];
  status: 'ok' | 'unavailable' | 'error';
}

interface Bottleneck {
  stage: string;
  conversionRate: number;
  suggestion: string;
}

interface FunnelData {
  stages: FunnelStage[];
  bottleneck: Bottleneck | null;
  period: { start: string; end: string };
}

type PeriodOption = '7d' | '30d' | '90d' | 'YTD';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatNumber(n: number): string {
  return n.toLocaleString();
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

function getBarColor(index: number, total: number, stageName: string): string {
  // Red for churned stages
  if (stageName.toLowerCase().includes('churn')) return '#f44336';
  // Gradient from blue (top) to green (bottom)
  const ratio = total > 1 ? index / (total - 1) : 0;
  const r = Math.round(25 + (76 - 25) * ratio);
  const g = Math.round(118 + (175 - 118) * ratio);
  const b = Math.round(210 + (80 - 210) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

// ---------------------------------------------------------------------------
// Funnel Bar Chart
// ---------------------------------------------------------------------------
function FunnelBarChart({ stages }: { stages: FunnelStage[] }) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (!chartRef.current || stages.length === 0) return;

    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    const labels = stages.map((s) => s.name);
    const data = stages.map((s) => s.count);
    const backgroundColors = stages.map((s, i) =>
      s.status === 'unavailable' ? '#bdbdbd' : getBarColor(i, stages.length, s.name)
    );
    const borderColors = stages.map((s) =>
      s.status === 'unavailable' ? '#9e9e9e' : 'transparent'
    );
    const borderDash = stages.map((s) => (s.status === 'unavailable' ? [6, 3] : []));

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
          title: { display: true, text: 'Marketing Funnel' },
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
                if (stage.status === 'unavailable') return '';
                if (ctx.dataIndex === 0) return '';
                return `Conversion from prev: ${stage.conversionRate.toFixed(1)}%`;
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
  }, [stages]);

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
                label={`${stage.conversionRate.toFixed(1)}%`}
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

      <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5, color: isUnavailable ? 'text.disabled' : 'text.primary' }}>
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
// Conversion Rate Summary
// ---------------------------------------------------------------------------
function ConversionSummary({ stages }: { stages: FunnelStage[] }) {
  const conversions = stages
    .filter((_, i) => i > 0)
    .map((stage, i) => ({
      from: stages[i].name,
      to: stage.name,
      rate: stage.conversionRate,
      available: stage.status !== 'unavailable' && stages[i].status !== 'unavailable',
    }));

  if (conversions.length === 0) return null;

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
        Stage-to-Stage Conversion Rates
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
        {conversions.map((c, i) => (
          <Box key={c.to} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {i > 0 && (
              <Typography variant="caption" color="text.disabled" sx={{ mx: 0.5 }}>
                |
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              {c.from} &rarr; {c.to}:
            </Typography>
            {c.available ? (
              <Chip
                label={`${c.rate.toFixed(1)}%`}
                size="small"
                color={getConversionColor(c.rate)}
                variant="outlined"
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            ) : (
              <Chip
                label="N/A"
                size="small"
                variant="outlined"
                sx={{ height: 20, fontSize: '0.7rem' }}
              />
            )}
          </Box>
        ))}
      </Box>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function FunnelTab() {
  const { token } = useAuth();
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<PeriodOption>('30d');

  useEffect(() => {
    if (!token) return;

    const fetchFunnel = async () => {
      try {
        setLoading(true);
        setError('');
        const res = await axios.get(buildApiUrl(`/api/admin/funnel-metrics?period=${period}`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        setData(res.data);
      } catch (err: any) {
        console.error('Error fetching funnel metrics:', err);
        if (err.response?.status === 404) {
          setError('Funnel metrics endpoint not available yet.');
        } else {
          setError('Failed to load funnel metrics.');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchFunnel();
  }, [token, period]);

  const handlePeriodChange = (_: React.MouseEvent<HTMLElement>, newPeriod: PeriodOption | null) => {
    if (newPeriod) setPeriod(newPeriod);
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

  if (!data || data.stages.length === 0) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        No funnel data available.
      </Alert>
    );
  }

  const { stages, bottleneck } = data;

  return (
    <Box>
      {/* Header + Period Selector */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">Marketing Funnel</Typography>
        <ToggleButtonGroup
          value={period}
          exclusive
          onChange={handlePeriodChange}
          size="small"
        >
          <ToggleButton value="7d">7d</ToggleButton>
          <ToggleButton value="30d">30d</ToggleButton>
          <ToggleButton value="90d">90d</ToggleButton>
          <ToggleButton value="YTD">YTD</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Bottleneck Alert */}
      {bottleneck && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Biggest drop-off: <strong>{bottleneck.stage}</strong> ({bottleneck.conversionRate.toFixed(1)}%).{' '}
          {bottleneck.suggestion}
        </Alert>
      )}

      {/* Funnel Bar Chart */}
      <FunnelBarChart stages={stages} />

      {/* Conversion Rate Summary */}
      <ConversionSummary stages={stages} />

      {/* Stage Detail Cards */}
      <Grid container spacing={2}>
        {stages.map((stage) => (
          <Grid item xs={12} sm={6} md={4} lg={3} key={stage.name}>
            <StageCard stage={stage} />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
