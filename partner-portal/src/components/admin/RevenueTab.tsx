import { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Alert,
  CircularProgress,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Grid,
} from '@mui/material';
import {
  TrendingUp as TrendingUpIcon,
  TrendingDown as TrendingDownIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';
import {
  RevenueMetrics,
  RevenueSnapshot,
  CohortRow,
  formatCents,
  formatCentsExact,
  formatPercent,
  formatChange,
  getMetricColor,
} from '../../utils/revenueMetrics';

Chart.register(...registerables);

interface RevenueData {
  metrics: RevenueMetrics;
  snapshots: RevenueSnapshot[];
  cohorts: CohortRow[];
}

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------
function KpiCard({
  label,
  value,
  change,
  changeLabel,
  color,
}: {
  label: string;
  value: string;
  change?: string;
  changeLabel?: string;
  color?: 'success' | 'warning' | 'error';
}) {
  const isPositive = change && !change.startsWith('-');
  return (
    <Paper sx={{ p: 3, mb: 2, height: '100%' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
        {label}
      </Typography>
      <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5 }}>
        {value}
      </Typography>
      {change != null && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {isPositive ? (
            <TrendingUpIcon fontSize="small" color="success" />
          ) : (
            <TrendingDownIcon fontSize="small" color="error" />
          )}
          <Chip
            label={change}
            size="small"
            color={color ?? (isPositive ? 'success' : 'error')}
            variant="outlined"
          />
          {changeLabel && (
            <Typography variant="caption" color="text.secondary">
              {changeLabel}
            </Typography>
          )}
        </Box>
      )}
      {!change && color && (
        <Chip
          label={color === 'success' ? 'Healthy' : color === 'warning' ? 'Watch' : 'At Risk'}
          size="small"
          color={color}
          variant="outlined"
        />
      )}
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// MRR Trend Chart
// ---------------------------------------------------------------------------
function MrrTrendChart({ snapshots }: { snapshots: RevenueSnapshot[] }) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (!chartRef.current || snapshots.length === 0) return;

    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    const labels = snapshots.map((s) => s.date);

    const config: ChartConfiguration = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Total MRR',
            data: snapshots.map((s) => s.mrr / 100),
            borderColor: '#1976d2',
            backgroundColor: 'rgba(25, 118, 210, 0.1)',
            fill: true,
            tension: 0.4,
          },
          {
            label: 'New MRR',
            data: snapshots.map((s) => s.newMrr / 100),
            borderColor: '#4caf50',
            backgroundColor: 'rgba(76, 175, 80, 0.1)',
            fill: false,
            tension: 0.4,
          },
          {
            label: 'Expansion MRR',
            data: snapshots.map((s) => s.expansionMrr / 100),
            borderColor: '#ff9800',
            backgroundColor: 'rgba(255, 152, 0, 0.1)',
            fill: false,
            tension: 0.4,
          },
          {
            label: 'Churned MRR',
            data: snapshots.map((s) => -(s.churnedMrr / 100)),
            borderColor: '#f44336',
            backgroundColor: 'rgba(244, 67, 54, 0.1)',
            fill: false,
            tension: 0.4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: 'MRR Trend' },
          legend: { position: 'top' as const },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = ctx.parsed.y;
                return `${ctx.dataset.label}: $${Math.abs(val).toLocaleString()}`;
              },
            },
          },
        },
        scales: {
          y: {
            ticks: {
              callback: (value) => `$${value}`,
            },
          },
          x: {
            ticks: { maxRotation: 45, minRotation: 45 },
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
  }, [snapshots]);

  return (
    <Paper sx={{ p: 3, mb: 2, height: 350 }}>
      <Box sx={{ position: 'relative', height: '100%' }}>
        <canvas ref={chartRef} />
      </Box>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Revenue Breakdown
// ---------------------------------------------------------------------------
function RevenueBreakdown({ snapshot }: { snapshot: RevenueSnapshot }) {
  const rows = [
    { label: 'New MRR', value: snapshot.newMrr, positive: true },
    { label: 'Expansion', value: snapshot.expansionMrr, positive: true },
    { label: 'Contraction', value: snapshot.contractionMrr, positive: false },
    { label: 'Churned', value: snapshot.churnedMrr, positive: false },
    { label: 'Net New', value: snapshot.netNewMrr, positive: snapshot.netNewMrr >= 0 },
  ];

  return (
    <Paper sx={{ p: 3, mb: 2 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>
        Revenue Breakdown ({snapshot.date})
      </Typography>
      <Table size="small">
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell sx={{ fontWeight: row.label === 'Net New' ? 700 : 400 }}>
                {row.label}
              </TableCell>
              <TableCell
                align="right"
                sx={{
                  fontWeight: row.label === 'Net New' ? 700 : 400,
                  color: row.positive ? 'success.main' : 'error.main',
                }}
              >
                {row.positive ? '+' : '-'}
                {formatCentsExact(Math.abs(row.value))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Cohort Retention Table
// ---------------------------------------------------------------------------
function CohortRetentionTable({ cohorts }: { cohorts: CohortRow[] }) {
  if (cohorts.length === 0) return null;

  const maxMonths = Math.max(...cohorts.map((c) => c.retention.length));

  const getCellColor = (pct: number): string => {
    if (pct >= 80) return 'rgba(76, 175, 80, 0.15)';
    if (pct >= 60) return 'rgba(255, 152, 0, 0.15)';
    return 'rgba(244, 67, 54, 0.15)';
  };

  return (
    <Paper sx={{ p: 3, mb: 2 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>
        Cohort Retention
      </Typography>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>Cohort</TableCell>
              <TableCell sx={{ fontWeight: 600 }} align="center">
                Users
              </TableCell>
              {Array.from({ length: maxMonths }, (_, i) => (
                <TableCell key={i} sx={{ fontWeight: 600 }} align="center">
                  M{i}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {cohorts.map((cohort) => (
              <TableRow key={cohort.cohortMonth}>
                <TableCell sx={{ fontWeight: 500 }}>{cohort.cohortMonth}</TableCell>
                <TableCell align="center">{cohort.startingCount}</TableCell>
                {Array.from({ length: maxMonths }, (_, i) => {
                  const val = cohort.retention[i];
                  if (val == null) return <TableCell key={i} />;
                  return (
                    <TableCell
                      key={i}
                      align="center"
                      sx={{
                        backgroundColor: getCellColor(val),
                        fontWeight: 500,
                        fontSize: '0.8rem',
                      }}
                    >
                      {formatPercent(val, 0)}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function RevenueTab() {
  const { token } = useAuth();
  const [data, setData] = useState<RevenueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;

    const fetchRevenue = async () => {
      try {
        setLoading(true);
        setError('');
        const res = await axios.get(buildApiUrl('/api/admin/revenue-metrics'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        setData(res.data);
      } catch (err: any) {
        console.error('Error fetching revenue metrics:', err);
        if (err.response?.status === 404) {
          setError('Revenue metrics endpoint not available yet.');
        } else {
          setError('Failed to load revenue metrics.');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchRevenue();
  }, [token]);

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

  if (!data) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        No revenue data available.
      </Alert>
    );
  }

  const { metrics, snapshots, cohorts } = data;
  const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        Revenue Metrics
      </Typography>

      {/* Top KPI Cards */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard
            label="Monthly Recurring Revenue"
            value={formatCents(metrics.currentMrr)}
            change={formatChange(metrics.mrrChange)}
            changeLabel="vs last month"
            color={getMetricColor('mrrChange', metrics.mrrChange)}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard
            label="Net Revenue Retention"
            value={formatPercent(metrics.nrr)}
            color={getMetricColor('nrr', metrics.nrr)}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard
            label="ARPU"
            value={formatCentsExact(metrics.arpu)}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KpiCard
            label="Gross Churn Rate"
            value={formatPercent(metrics.grossChurnRate)}
            color={getMetricColor('churn', metrics.grossChurnRate)}
          />
        </Grid>
      </Grid>

      {/* Secondary Stats */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5 }}>
          Subscription Overview
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
          <Chip label={`Active: ${metrics.activeCount}`} color="success" variant="outlined" />
          <Chip label={`Paying: ${metrics.payingCount}`} color="primary" variant="outlined" />
          <Chip label={`Trial: ${metrics.trialCount}`} color="info" variant="outlined" />
          <Chip
            label={`Past Due: ${metrics.pastDueCount}`}
            color={metrics.pastDueCount > 0 ? 'warning' : 'default'}
            variant="outlined"
          />
          <Chip
            label={`Churned This Month: ${metrics.churnedCount}`}
            color={metrics.churnedCount > 0 ? 'error' : 'default'}
            variant="outlined"
          />
          <Chip label={`ARR: ${formatCents(metrics.arr)}`} variant="outlined" />
          <Chip label={`LTV Est: ${formatCentsExact(metrics.ltv)}`} variant="outlined" />
        </Box>
      </Paper>

      {/* MRR Trend Chart */}
      {snapshots.length > 0 && <MrrTrendChart snapshots={snapshots} />}

      {/* Revenue Breakdown + Cohort side by side on larger screens */}
      <Grid container spacing={2}>
        {latestSnapshot && (
          <Grid item xs={12} md={cohorts.length > 0 ? 5 : 12}>
            <RevenueBreakdown snapshot={latestSnapshot} />
          </Grid>
        )}
        {cohorts.length > 0 && (
          <Grid item xs={12} md={latestSnapshot ? 7 : 12}>
            <CohortRetentionTable cohorts={cohorts} />
          </Grid>
        )}
      </Grid>
    </Box>
  );
}
