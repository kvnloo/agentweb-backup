import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Collapse,
  Grid,
  IconButton,
  MenuItem,
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
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import InfoIcon from "@mui/icons-material/InfoOutlined";
import axios from "axios";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl } from "../../config";

// ── Mirrors the backend GET /api/admin/usage/cost-aggregation response
// (usageAnalyticsService.getCostAggregation). Every dollar figure is
// server-computed from the ledger's stored costMicroUsd — never re-derived here.
export interface CostByModelRow {
  model: string;
  costUsd: number;
  callCount: number;
  totalTokens: number;
}

export interface CostTopUser {
  userId: string;
  email: string | null;
  costUsd: number;
  callCount: number;
  totalTokens: number;
  byModel: CostByModelRow[];
}

export interface CostByFeatureRow {
  feature: string;
  costUsd: number;
  callCount: number;
  totalTokens: number;
}

export interface CostByXAccountRow {
  accountId: string;
  handle: string | null;
  costUsd: number;
  callCount: number;
}

export interface CostAggregation {
  start: string;
  end: string;
  totals: { costUsd: number; callCount: number; totalTokens: number };
  byModel: CostByModelRow[];
  byFeature: CostByFeatureRow[];
  topUsers: CostTopUser[];
  /** Per-X-account spend with @handle enrichment (ENG-664). */
  byXAccount?: CostByXAccountRow[];
}

// ── X reconciliation, mirroring GET /api/admin/usage/x-reconciliation ─────────
export interface XReconciliation {
  cycle: { start: string; end: string };
  measured: {
    projectId: string | null;
    projectCap: number;
    projectUsage: number;
    capResetDay: number | null;
  };
  allocated: { costUsd: number; callCount: number; postReadUnits: number };
  reconciliation: {
    allocatedPostReadUnits: number;
    measuredPostReadUnits: number;
    dedupSavingsUnits: number;
    capUsedPct: number | null;
    measuredDerivedCostUsd: number;
  };
}

export interface XAccountRow {
  accountId: string;
  handle: string | null;
  costUsd: number;
  callCount: number;
}

/**
 * Per-X-account rollup from the feature dimension. X rows are stored with
 * feature "x-account:{id}" (twitterService), so filtering that prefix yields
 * per-account totals; every other feature (LLM session types) is skipped.
 * Handle is null here — this is the fallback when the server did not send the
 * enriched byXAccount cut.
 */
export function xAccountsFromFeatures(byFeature: CostByFeatureRow[] | undefined): XAccountRow[] {
  const prefix = "x-account:";
  return (byFeature || [])
    .filter((f) => f.feature.startsWith(prefix))
    .map((f) => ({
      accountId: f.feature.slice(prefix.length),
      handle: null,
      costUsd: f.costUsd,
      callCount: f.callCount,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.accountId.localeCompare(b.accountId));
}

/**
 * Prefer the server-enriched per-account cut (carries @handle); fall back to the
 * client-side feature derivation (handle=null → raw accountId shown) when absent.
 */
export function xAccountRows(agg: CostAggregation | null): XAccountRow[] {
  if (agg?.byXAccount) {
    return [...agg.byXAccount].sort(
      (a, b) => b.costUsd - a.costUsd || a.accountId.localeCompare(b.accountId)
    );
  }
  return xAccountsFromFeatures(agg?.byFeature);
}

/** Display label for an X account: @handle when known, else the raw id. */
export function xAccountLabel(row: XAccountRow): string {
  return row.handle ? `@${row.handle}` : row.accountId;
}

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

/**
 * Provider a ledger `model` string belongs to. Vendor rows are namespaced
 * `{provider}:{operation}` where the operation is a WORD (e.g. "twitter:post",
 * "v0:generate"). An LLM model id is "llm" — including Bedrock ids that carry a
 * NUMERIC version suffix after a colon (e.g.
 * "anthropic.claude-sonnet-4-5-20250929-v1:0"), which must NOT be mistaken for a
 * vendor namespace. A plain id ("claude-opus-4-8") is likewise LLM.
 */
export function providerOfModel(model: string): string {
  const i = model.indexOf(":");
  if (i <= 0) return "llm";
  const suffix = model.slice(i + 1);
  // A purely-numeric suffix is a model version tag (Bedrock), not a vendor op.
  if (/^\d+$/.test(suffix)) return "llm";
  return model.slice(0, i);
}

const TWITTER_PROVIDER_KEY = "twitter";

/**
 * Provider options for the filter: "all" first, then the providers present in
 * the data. "twitter" is ALWAYS offered even with no X rows — this tab exists for
 * X metering, so the X filter must be discoverable before any X usage accrues
 * (selecting it then shows the empty state rather than hiding the option).
 */
export function providersInData(agg: CostAggregation | null): string[] {
  const set = new Set<string>([TWITTER_PROVIDER_KEY]);
  if (agg) {
    for (const u of agg.topUsers) {
      for (const m of u.byModel) set.add(providerOfModel(m.model));
    }
  }
  return ["all", ...[...set].sort()];
}

export interface UserRowView {
  userId: string;
  email: string | null;
  costUsd: number;
  callCount: number;
  rows: CostByModelRow[];
}

/**
 * A user's usage restricted to one provider ("all" = no filter). Recomputes
 * cost/calls from the per-model rows so the totals always match the filter — a
 * user with zero spend under the selected provider drops out (null).
 */
export function userRowForProvider(
  user: CostTopUser,
  provider: string
): UserRowView | null {
  const rows =
    provider === "all"
      ? user.byModel
      : user.byModel.filter((m) => providerOfModel(m.model) === provider);
  if (rows.length === 0) return null;
  const costUsd = rows.reduce((s, m) => s + (m.costUsd || 0), 0);
  const callCount = rows.reduce((s, m) => s + (m.callCount || 0), 0);
  return { userId: user.userId, email: user.email, costUsd, callCount, rows };
}

/** All users with spend under the selected provider, ranked by cost desc. */
export function rankedUserRows(
  agg: CostAggregation | null,
  provider: string
): UserRowView[] {
  if (!agg) return [];
  return agg.topUsers
    .map((u) => userRowForProvider(u, provider))
    .filter((r): r is UserRowView => r !== null)
    .sort((a, b) => b.costUsd - a.costUsd || a.userId.localeCompare(b.userId));
}

/** X spend is an allocated estimate (see twitterPricing) — flag it in the UI. */
export function providerIsAllocatedEstimate(provider: string): boolean {
  return provider === "twitter";
}

/** Format a Date as local YYYY-MM-DD (no UTC shift — matches what the user picks). */
function formatDateInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
/** Parse a YYYY-MM-DD string to a local-midnight Date for the calendar picker. */
function parseDateInput(s: string): Date | null {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function defaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return formatDateInput(d);
}

/** Quick range presets — one-click ranges so no typing is needed. */
const RANGE_PRESETS: { label: string; range: () => { start: string; end: string } }[] = [
  { label: "7d", range: () => rangeDaysBack(7) },
  { label: "30d", range: () => rangeDaysBack(30) },
  { label: "90d", range: () => rangeDaysBack(90) },
  {
    label: "This month",
    range: () => {
      const now = new Date();
      return { start: formatDateInput(new Date(now.getFullYear(), now.getMonth(), 1)), end: formatDateInput(now) };
    },
  },
];
function rangeDaysBack(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  return { start: formatDateInput(start), end: formatDateInput(end) };
}
function usd(n: number): string {
  return `$${(n || 0).toFixed(n < 1 ? 4 : 2)}`;
}
function providerLabel(p: string): string {
  if (p === "all") return "All providers";
  if (p === "llm") return "LLM (tokens)";
  if (p === "twitter") return "X (Twitter)";
  return p;
}

const UserUsageRow: React.FC<{ rank: number; row: UserRowView; provider: string }> = ({
  rank,
  row,
  provider,
}) => {
  const [open, setOpen] = useState(false);
  const sortedModels = useMemo(
    () => [...row.rows].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)),
    [row.rows]
  );
  return (
    <>
      <TableRow hover>
        <TableCell padding="checkbox">
          <IconButton size="small" onClick={() => setOpen((o) => !o)} aria-label="expand">
            {open ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
          </IconButton>
        </TableCell>
        <TableCell>{rank}</TableCell>
        <TableCell>
          <Typography variant="body2">{row.email || "(no email on file)"}</Typography>
          <Typography variant="caption" color="text.secondary">
            {row.userId}
          </Typography>
        </TableCell>
        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {row.callCount.toLocaleString()}
        </TableCell>
        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {usd(row.costUsd)}
          {providerIsAllocatedEstimate(provider) && (
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
              sx={{ ml: 0.75 }}
            >
              allocated
            </Typography>
          )}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell sx={{ py: 0, border: 0 }} colSpan={5}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ m: 1 }}>
              <Table size="small" data-testid={`breakdown-${row.userId}`}>
                <TableHead>
                  <TableRow>
                    <TableCell>Tool / model</TableCell>
                    <TableCell align="right">Calls</TableCell>
                    <TableCell align="right">Cost</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sortedModels.map((m) => (
                    <TableRow key={m.model}>
                      <TableCell>{m.model}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {(m.callCount || 0).toLocaleString()}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                        {usd(m.costUsd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
};

/**
 * X (Twitter) reconciliation panel — X's own measured consumption beside our
 * allocated ledger for the same billing cycle. Fetched separately so an
 * X-unreachable failure (e.g. bearer not configured → 502) degrades to a note
 * without breaking the rest of the tab.
 */
const XReconciliationPanel: React.FC = () => {
  const { token } = useAuth();
  const [data, setData] = useState<XReconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await axios.get<XReconciliation>(
          buildApiUrl("/api/admin/usage/x-reconciliation"),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (alive) setData(res.data);
      } catch (err: any) {
        if (alive)
          setError(err?.response?.data?.message || err?.message || "X usage unavailable");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return null;
  if (error || !data) {
    return (
      <Alert severity="warning" sx={{ mb: 2 }} data-testid="x-recon-error">
        X reconciliation unavailable: {error || "no data"}
      </Alert>
    );
  }

  const { measured, allocated, reconciliation: r, cycle } = data;
  const capPct = r.capUsedPct ?? 0;
  const capColor = capPct >= 90 ? "error.main" : capPct >= 70 ? "warning.main" : "success.main";

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="x-recon-panel">
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          X API reconciliation
        </Typography>
        <Tooltip
          title="Measured = X's own GET /2/usage/tweets (app-wide, deduped). Allocated = our per-call ledger × X's rate card (upper bound). The gap is dedup savings + $0 interaction writes."
          arrow
        >
          <InfoIcon sx={{ fontSize: 16, color: "text.disabled", cursor: "help" }} />
        </Tooltip>
        <Typography variant="caption" color="text.secondary">
          cycle {cycle.start} → {cycle.end}
          {measured.capResetDay ? ` (resets day ${measured.capResetDay})` : ""}
        </Typography>
      </Box>
      <Grid container spacing={2}>
        <Grid item xs={12} md={3}>
          <Typography variant="caption" color="text.secondary">
            Post-read cap used (measured)
          </Typography>
          <Typography variant="h6" sx={{ color: capColor, fontVariantNumeric: "tabular-nums" }} data-testid="x-recon-cap">
            {measured.projectUsage.toLocaleString()} / {measured.projectCap.toLocaleString()}
            {r.capUsedPct != null ? ` (${capPct.toFixed(1)}%)` : ""}
          </Typography>
        </Grid>
        <Grid item xs={12} md={3}>
          <Typography variant="caption" color="text.secondary">
            Allocated reads (ours)
          </Typography>
          <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {r.allocatedPostReadUnits.toLocaleString()}
          </Typography>
          <Typography variant="caption" color="text.secondary" data-testid="x-recon-dedup">
            {r.dedupSavingsUnits.toLocaleString()} deduped by X
          </Typography>
        </Grid>
        <Grid item xs={12} md={3}>
          <Typography variant="caption" color="text.secondary">
            Allocated cost (upper bound)
          </Typography>
          <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {usd(allocated.costUsd)}
          </Typography>
        </Grid>
        <Grid item xs={12} md={3}>
          <Typography variant="caption" color="text.secondary">
            Measured-derived cost
          </Typography>
          <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }} data-testid="x-recon-measured-cost">
            {usd(r.measuredDerivedCostUsd)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            X reads × rate + our writes
          </Typography>
        </Grid>
      </Grid>
    </Paper>
  );
};

const XAccountTable: React.FC<{ accounts: XAccountRow[] }> = ({ accounts }) => {
  if (accounts.length === 0) return null;
  return (
    <Box sx={{ mt: 3 }} data-testid="x-account-table">
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
        By X account
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Connected account</TableCell>
              <TableCell align="right">Calls</TableCell>
              <TableCell align="right">Cost (allocated)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.accountId} hover>
                <TableCell>
                  {xAccountLabel(a)}
                  {a.handle && (
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      {a.accountId}
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {a.callCount.toLocaleString()}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {usd(a.costUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};

export default function UsageCostByUserTab() {
  const { token } = useAuth();
  const [start, setStart] = useState(defaultStartDate);
  const [end, setEnd] = useState(() => formatDateInput(new Date()));
  const [provider, setProvider] = useState("all");
  const [agg, setAgg] = useState<CostAggregation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAggregation = async (s: string = start, e: string = end) => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get<CostAggregation>(
        buildApiUrl(
          `/api/admin/usage/cost-aggregation?start=${encodeURIComponent(
            s
          )}&end=${encodeURIComponent(e)}&topUsers=100`
        ),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setAgg(response.data);
    } catch (err: any) {
      setError(
        err?.response?.data?.message ||
          err?.response?.data?.error ||
          err?.message ||
          "Failed to load usage aggregation"
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAggregation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providers = useMemo(() => providersInData(agg), [agg]);
  const rows = useMemo(() => rankedUserRows(agg, provider), [agg, provider]);
  const xAccounts = useMemo(() => xAccountRows(agg), [agg]);
  const filteredTotals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.costUsd += r.costUsd;
          acc.callCount += r.callCount;
          return acc;
        },
        { costUsd: 0, callCount: 0 }
      ),
    [rows]
  );

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h6">Usage &amp; cost by user</Typography>
          <Typography variant="body2" color="text.secondary">
            Credits (metered $ cost) each user has spent across LLM and vendor APIs (incl. X/Twitter),
            over the selected range.
          </Typography>
        </Box>
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={() => loadAggregation()} disabled={loading}>
          Refresh
        </Button>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} md={3}>
            <DatePicker
              label="Start"
              value={parseDateInput(start)}
              maxDate={parseDateInput(end) ?? undefined}
              onChange={(d: Date | null) => d && setStart(formatDateInput(d))}
              slotProps={{ textField: { fullWidth: true, size: "small" } }}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <DatePicker
              label="End"
              value={parseDateInput(end)}
              minDate={parseDateInput(start) ?? undefined}
              onChange={(d: Date | null) => d && setEnd(formatDateInput(d))}
              slotProps={{ textField: { fullWidth: true, size: "small" } }}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              select
              fullWidth
              size="small"
              label="Provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              {providers.map((p) => (
                <MenuItem key={p} value={p}>
                  {providerLabel(p)}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={12} md={3}>
            <Button fullWidth variant="contained" onClick={() => loadAggregation()} disabled={loading}>
              Apply range
            </Button>
          </Grid>
          <Grid item xs={12}>
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
              <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                Quick range:
              </Typography>
              {RANGE_PRESETS.map((p) => (
                <Button
                  key={p.label}
                  size="small"
                  variant="outlined"
                  disabled={loading}
                  onClick={() => {
                    const r = p.range();
                    setStart(r.start);
                    setEnd(r.end);
                    void loadAggregation(r.start, r.end);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </Box>
          </Grid>
        </Grid>
      </Paper>

      <XReconciliationPanel />

      {providerIsAllocatedEstimate(provider) && (
        <Alert severity="info" icon={<InfoIcon />} sx={{ mb: 2 }}>
          X (Twitter) cost is <strong>allocated</strong> — X publishes no per-call price, so this applies
          X&apos;s pay-per-use rate card to our call counts. It is an upper-bound estimate (X charges a
          repeat read of the same resource within a UTC day only once), not the console-billed figure.
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={4}>
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Total cost ({providerLabel(provider)})
                </Typography>
                <Typography variant="h6" data-testid="total-cost" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {usd(filteredTotals.costUsd)}
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={4}>
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Total calls
                </Typography>
                <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {filteredTotals.callCount.toLocaleString()}
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={4}>
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Users with spend
                </Typography>
                <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {rows.length.toLocaleString()}
                </Typography>
              </Paper>
            </Grid>
          </Grid>

          {rows.length === 0 ? (
            <Alert severity="info">No metered usage for this range and provider.</Alert>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>#</TableCell>
                    <TableCell>User</TableCell>
                    <TableCell align="right">Calls</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Metered $ cost drawn from the usage ledger over the range">
                        <span>Cost</span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row, i) => (
                    <UserUsageRow key={row.userId} rank={i + 1} row={row} provider={provider} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <XAccountTable accounts={xAccounts} />
        </>
      )}
    </Box>
  );
}
