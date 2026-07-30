import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Card,
  CardContent,
  CircularProgress,
  Grid,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl } from "../../config";

interface Counters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  callCount: number;
  costMicroUsd: number;
  costUsd: number;
}

interface ModelCost extends Counters {
  model: string;
}

interface SeriesCost {
  date: string;
  model: string;
  costMicroUsd: number;
  costUsd: number;
  totalTokens: number;
  callCount: number;
}

interface TopUser extends Counters {
  userId: string;
  email: string | null;
  byModel: ModelCost[];
}

interface CostAggregation {
  start: string;
  end: string;
  totals: Counters;
  byModel: ModelCost[];
  series: SeriesCost[];
  topUsers: TopUser[];
}

type Preset = "7d" | "30d" | "custom";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function presetWindow(days: number, now = new Date()): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: isoDate(start), end: isoDate(end) };
}

function seriesByDate(rows: SeriesCost[]) {
  const dates = new Map<string, SeriesCost[]>();
  for (const row of rows) {
    const existing = dates.get(row.date);
    if (existing) existing.push(row);
    else dates.set(row.date, [row]);
  }
  return [...dates.entries()]
    .map(([date, items]) => ({
      date,
      items: [...items].sort((a, b) => b.costUsd - a.costUsd),
      total: items.reduce((sum, item) => sum + item.costUsd, 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export default function CostDashboardTab() {
  const { token } = useAuth();
  const defaultWindow = useMemo(() => presetWindow(30), []);
  const [preset, setPreset] = useState<Preset>("30d");
  const [window, setWindow] = useState(defaultWindow);
  const [customStart, setCustomStart] = useState(defaultWindow.start);
  const [customEnd, setCustomEnd] = useState(defaultWindow.end);
  const [data, setData] = useState<CostAggregation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("Admin authentication is required.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    const params = new URLSearchParams(window);

    axios
      .get(buildApiUrl(`/api/admin/usage/cost-aggregation?${params.toString()}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((response) => {
        if (!cancelled) setData(response.data);
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(
            requestError?.response?.data?.message ||
              requestError?.message ||
              "Failed to load cost aggregation."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, window]);

  const selectPreset = (next: Exclude<Preset, "custom">) => {
    setPreset(next);
    setWindow(presetWindow(next === "7d" ? 7 : 30));
  };

  const applyCustomWindow = () => {
    if (!customStart || !customEnd || customStart > customEnd) {
      setError("Choose a valid custom date range.");
      return;
    }
    setWindow({ start: customStart, end: customEnd });
  };

  const dailySeries = seriesByDate(data?.series ?? []);
  const maxDailySpend = Math.max(...dailySeries.map((row) => row.total), 0);
  const colors = ["#155EEF", "#7F56D9", "#039855", "#DC6803", "#D92D20", "#667085"];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box
        sx={{
          display: "flex",
          gap: 2,
          alignItems: { xs: "stretch", md: "center" },
          justifyContent: "space-between",
          flexDirection: { xs: "column", md: "row" },
        }}
      >
        <Box>
          <Typography variant="h5">LLM cost dashboard</Typography>
          <Typography variant="body2" color="text.secondary">
            Actual recorded spend from the canonical usage ledger.
          </Typography>
        </Box>
        <ButtonGroup size="small" aria-label="Cost window">
          <Button
            variant={preset === "7d" ? "contained" : "outlined"}
            onClick={() => selectPreset("7d")}
          >
            7 days
          </Button>
          <Button
            variant={preset === "30d" ? "contained" : "outlined"}
            onClick={() => selectPreset("30d")}
          >
            30 days
          </Button>
          <Button
            variant={preset === "custom" ? "contained" : "outlined"}
            onClick={() => setPreset("custom")}
          >
            Custom
          </Button>
        </ButtonGroup>
      </Box>

      {preset === "custom" && (
        <Paper
          variant="outlined"
          sx={{ p: 2, display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}
        >
          <TextField
            label="Start date"
            type="date"
            size="small"
            value={customStart}
            onChange={(event) => setCustomStart(event.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            label="End date"
            type="date"
            size="small"
            value={customEnd}
            onChange={(event) => setCustomEnd(event.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <Button variant="contained" onClick={applyCustomWindow}>
            Apply
          </Button>
        </Paper>
      )}

      {error && <Alert severity="error">{error}</Alert>}

      {loading && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
          <CircularProgress aria-label="Loading LLM costs" />
        </Box>
      )}

      {!loading && data && data.totals.callCount === 0 && (
        <Alert severity="info">
          No LLM usage was recorded in this window. Try a wider date range.
        </Alert>
      )}

      {!loading && data && data.totals.callCount > 0 && (
        <>
          <Grid container spacing={2}>
            {[
              ["Total spend", usd.format(data.totals.costUsd)],
              ["LLM calls", integer.format(data.totals.callCount)],
              ["Tokens", integer.format(data.totals.totalTokens)],
              ["Models", integer.format(data.byModel.length)],
            ].map(([label, value]) => (
              <Grid item xs={12} sm={6} md={3} key={label}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="body2" color="text.secondary">
                      {label}
                    </Typography>
                    <Typography variant="h5">{value}</Typography>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>

          <Grid container spacing={3}>
            <Grid item xs={12} lg={6}>
              <Typography variant="h6" gutterBottom>
                Spend by model
              </Typography>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label="Spend by model">
                  <TableHead>
                    <TableRow>
                      <TableCell>Model</TableCell>
                      <TableCell align="right">Spend</TableCell>
                      <TableCell align="right">Calls</TableCell>
                      <TableCell align="right">Tokens</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.byModel.map((row) => (
                      <TableRow key={row.model}>
                        <TableCell>{row.model}</TableCell>
                        <TableCell align="right">{usd.format(row.costUsd)}</TableCell>
                        <TableCell align="right">{integer.format(row.callCount)}</TableCell>
                        <TableCell align="right">{integer.format(row.totalTokens)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Grid>

            <Grid item xs={12} lg={6}>
              <Typography variant="h6" gutterBottom>
                Spend over time
              </Typography>
              <Paper
                variant="outlined"
                aria-label="Spend over time"
                sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}
              >
                {dailySeries.map((day) => (
                  <Box key={day.date}>
                    <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
                      <Typography variant="caption">{day.date}</Typography>
                      <Typography variant="caption">{usd.format(day.total)}</Typography>
                    </Box>
                    <Box
                      sx={{
                        height: 12,
                        borderRadius: 6,
                        overflow: "hidden",
                        bgcolor: "action.hover",
                        display: "flex",
                        width: `${Math.max(
                          maxDailySpend ? (day.total / maxDailySpend) * 100 : 0,
                          2
                        )}%`,
                      }}
                    >
                      {day.items.map((item, index) => (
                        <Box
                          key={`${day.date}-${item.model}`}
                          aria-label={`${day.date} ${item.model}: ${usd.format(item.costUsd)}`}
                          title={`${item.model}: ${usd.format(item.costUsd)}`}
                          sx={{
                            width: `${day.total ? (item.costUsd / day.total) * 100 : 0}%`,
                            bgcolor: colors[index % colors.length],
                          }}
                        />
                      ))}
                    </Box>
                  </Box>
                ))}
              </Paper>
            </Grid>
          </Grid>

          <Box>
            <Typography variant="h6" gutterBottom>
              Top users by spend
            </Typography>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label="Top users by spend">
                <TableHead>
                  <TableRow>
                    <TableCell>User</TableCell>
                    <TableCell align="right">Spend</TableCell>
                    <TableCell align="right">Calls</TableCell>
                    <TableCell align="right">Tokens</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.topUsers.map((row) => (
                    <TableRow key={row.userId}>
                      <TableCell>{row.email || row.userId}</TableCell>
                      <TableCell align="right">{usd.format(row.costUsd)}</TableCell>
                      <TableCell align="right">{integer.format(row.callCount)}</TableCell>
                      <TableCell align="right">{integer.format(row.totalTokens)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </>
      )}
    </Box>
  );
}
