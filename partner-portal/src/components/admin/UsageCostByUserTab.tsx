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
  /**
   * Distinct users with spend over the FULL range — not just topUsers, which is
   * capped server-side. Use this for the headline user count so it isn't
   * truncated to the top-N. Optional for back-compat with older payloads.
   */
  userCount?: number;
  /** Per-X-account spend with @handle enrichment (ENG-664). */
  byXAccount?: CostByXAccountRow[];
  /**
   * Provider scopes the picker may offer, computed server-side over the
   * UNFILTERED window (ENG-1837). Optional: an older backend omits it and the
   * client falls back to deriving options from the rows it can see.
   */
  availableProviders?: string[];
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
    /** >0 means measured reads exceeded allocated — an internal metering gap. */
    attributionGapUnits?: number;
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

/** Selected on first load (ENG-1837): the tab answers "who spent our vendor
 *  budget", and opening on one vendor hides the total. X is one click away. */
export const DEFAULT_PROVIDER = "all";

/**
 * Scopes, not vendors. Always offered, because no row implies them: "llm" would
 * vanish from a vendor-scoped response even though it is always selectable.
 * Mirrors the backend's AGGREGATION_SCOPES.
 */
const AGGREGATION_SCOPES = ["all", "llm"] as const;

/**
 * Provider options for the filter.
 *
 * Prefers the server's `availableProviders` (ENG-1837), computed over the
 * unfiltered window, so the list does not collapse to whatever is selected.
 *
 * Falls back to deriving options from the rows in hand, which is what makes the
 * backend and portal deploys order-independent. The fallback is *cumulative*:
 * `known` carries the options discovered so far, because a scoped response only
 * contains its own vendor's rows. Deriving from it alone would delete every
 * other option the moment one was picked — the picker would offer a way in and
 * no way back, which is worse than not broadening the tab at all (CodeRabbit,
 * PR #2841). The server list, when present, replaces `known` rather than
 * merging with it: it is authoritative and complete.
 *
 * "twitter" is ALWAYS offered in the fallback: this tab began as X-only
 * (ENG-664), so the X filter must stay discoverable before any X usage accrues
 * (selecting it then shows the empty state rather than hiding the option).
 */
export function providersInData(
  agg: CostAggregation | null,
  known: readonly string[] = []
): string[] {
  if (agg?.availableProviders?.length) return agg.availableProviders;
  const vendors = new Set<string>([TWITTER_PROVIDER_KEY]);
  for (const p of known) {
    if (!(AGGREGATION_SCOPES as readonly string[]).includes(p)) vendors.add(p);
  }
  for (const u of agg?.topUsers ?? []) {
    for (const m of u.byModel) {
      const p = providerOfModel(m.model);
      // "llm" is a scope, already fixed above — not a vendor to sort among them.
      if (p !== "llm") vendors.add(p);
    }
  }
  return [...AGGREGATION_SCOPES, ...[...vendors].sort()];
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

/**
 * X charges a repeat read of the SAME resource within a UTC day only once, and
 * we do not track resource ids — so our X figure is an allocated UPPER BOUND.
 *
 * X-specific on purpose. No other metered vendor dedups, so generalising this
 * caveat would attach a qualifier to figures it is not true of (ENG-1837 AC5).
 */
export function providerHasDedupCaveat(provider: string): boolean {
  return provider === TWITTER_PROVIDER_KEY || provider === "all";
}

/**
 * ElevenLabs, 2captcha and Placid have rates but no metering adapter yet
 * (ENG-698, blocked on the ENG-1598 Placid credential), so an all-vendor total
 * omits them. Say so rather than letting the figure read as complete.
 *
 * DELETE this and its usage when ENG-698 ships.
 */
export function providerTotalIsUndercount(provider: string): boolean {
  return provider === "all";
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
const PROVIDER_LABELS: Record<string, string> = {
  all: "All providers",
  llm: "LLM (tokens)",
  twitter: "X (Twitter)",
  v0: "v0 (Vercel)",
  "you.com": "You.com search",
  google_cse: "Google Custom Search",
  apollo: "Apollo",
  "enrich.so": "enrich.so",
  remotion: "Remotion Lambda",
};

/** An unknown key falls through unchanged — a new vendor is listed by its raw
 *  key rather than being hidden until someone adds a label. */
export function providerLabel(p: string): string {
  return PROVIDER_LABELS[p] ?? p;
}

/**
 * What a ledger row's user actually is when it has no email (ENG-1860).
 *
 * `(no email on file)` collapsed four genuinely different situations into one
 * blank-looking string, and hid the one that matters: `system` is the single
 * largest call count on the page — 29% of metered calls in the window checked
 * on 2026-09-10 — and read like a data-quality nit rather than an attribution
 * gap ([[ENG-1858]]).
 *
 * Classified on the id's SHAPE, so it costs no extra lookup. The raw id keeps
 * rendering beneath the label either way.
 */
export function unattributedUserLabel(userId: string): string {
  if (userId === "system") return "System (unattributed)";
  if (userId.startsWith("anon_")) return "Anonymous session";
  // Deliberately not "deleted": we know the lookup missed, not why. Asserting a
  // cause we have not established would be a different kind of wrong.
  return "Unknown or unresolved user";
}

/** Header for the drill-down's first column. A vendor row is a TOOL, not a
 *  model — labelling it "Model" is the mis-read ENG-1519 was filed for. */
export function breakdownColumnLabel(provider: string): string {
  if (provider === "llm") return "Model";
  if (provider === "all") return "Tool / model";
  return "Tool";
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
          <Typography variant="body2" color={row.email ? undefined : "text.secondary"}>
            {row.email || unattributedUserLabel(row.userId)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {row.userId}
          </Typography>
        </TableCell>
        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {row.callCount.toLocaleString()}
        </TableCell>
        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {usd(row.costUsd)}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell sx={{ py: 0, border: 0 }} colSpan={5}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ m: 1 }}>
              <Table size="small" data-testid={`breakdown-${row.userId}`}>
                <TableHead>
                  <TableRow>
                    <TableCell>{breakdownColumnLabel(provider)}</TableCell>
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
          {(r.attributionGapUnits ?? 0) > 0 && (
            <Typography variant="caption" color="error.main" display="block" data-testid="x-recon-gap">
              ⚠ {r.attributionGapUnits!.toLocaleString()} reads unattributed (measured &gt; allocated — metering gap)
            </Typography>
          )}
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
        By X account <Typography component="span" variant="caption" color="text.secondary">(X spend only)</Typography>
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Connected account</TableCell>
              <TableCell align="right">Calls</TableCell>
              <TableCell align="right">Cost</TableCell>
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
  // ENG-1837: was pinned to X. Every metered vendor writes to the same ledger,
  // and the server scopes the aggregation, so this is now a selection.
  const [provider, setProvider] = useState<string>(DEFAULT_PROVIDER);
  const [agg, setAgg] = useState<CostAggregation | null>(null);
  // Accumulated across loads, so a vendor-scoped response from an older backend
  // cannot erase the options discovered by the first `provider=all` load.
  const [providerOptions, setProviderOptions] = useState<string[]>(() => providersInData(null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `p` is passed explicitly by the selector rather than read from state: a
  // change handler runs before its setState has settled, so relying on `provider`
  // here would fetch the PREVIOUS selection.
  const loadAggregation = async (s: string = start, e: string = end, p: string = provider) => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get<CostAggregation>(
        buildApiUrl(
          // The server scopes every cut (totals, byModel, byFeature, topUsers,
          // userCount, byXAccount) to `provider` before aggregating, so nothing
          // is re-derived client-side — notably userCount, which cannot be
          // recovered from the capped topUsers slice (ENG-664 review round).
          `/api/admin/usage/cost-aggregation?start=${encodeURIComponent(
            s
          )}&end=${encodeURIComponent(e)}&topUsers=100&provider=${encodeURIComponent(p)}`
        ),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setAgg(response.data);
      setProviderOptions((prev) => providersInData(response.data, prev));
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

  const rows = useMemo(() => rankedUserRows(agg, provider), [agg, provider]);
  const xAccounts = useMemo(() => xAccountRows(agg), [agg]);
  // Headline totals come from the server's COMPLETE aggregation (agg.totals),
  // not a sum over `rows` — `rows` is the capped topUsers slice and would
  // understate cost/calls once spenders exceed the server's topUsers limit.
  // The request carries the selection, so agg.totals is already provider-scoped.
  const filteredTotals = useMemo(
    () => ({ costUsd: agg?.totals.costUsd ?? 0, callCount: agg?.totals.callCount ?? 0 }),
    [agg]
  );

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h6">
            {providerLabel(provider)} usage &amp; cost by user
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Allocated $ cost each user has spent, by tool, over the selected range. Pick a
            vendor to scope every figure on this page.
          </Typography>
        </Box>
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={() => loadAggregation()} disabled={loading}>
          Refresh
        </Button>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} md={3}>
            <TextField
              select
              fullWidth
              size="small"
              label="Provider"
              value={provider}
              onChange={(e) => {
                const next = e.target.value;
                setProvider(next);
                void loadAggregation(start, end, next);
              }}
              disabled={loading}
              data-testid="provider-select"
            >
              {providerOptions.map((p) => (
                <MenuItem key={p} value={p}>
                  {providerLabel(p)}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
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

      {/* X-only: it reconciles against X's OWN billing cycle, which has no
          meaning under another vendor — and it costs a second request. */}
      {provider === TWITTER_PROVIDER_KEY && <XReconciliationPanel />}

      {/* Unconditional, and that is the point: EVERY figure on this tab is
          allocated — our rate card applied to a call count — including LLM
          dollars, which always were (ENG-693 AC3) and never said so. The old
          `providerIsAllocatedEstimate` predicate hardcoded "twitter", so every
          other vendor's cost read as vendor-measured. Deleted rather than
          generalised: a predicate that is always true is a lie with a signature.
          The dedup sentence below stays conditional, because it is X-specific. */}
      <Alert severity="info" icon={<InfoIcon />} sx={{ mb: 2 }} data-testid="allocated-caveat">
        These are <strong>allocated</strong> costs — our own rate card applied to metered usage,
        never a vendor-invoiced amount. True of LLM dollars too (ENG-693).
        {providerHasDedupCaveat(provider) && (
          <>
            {" "}
            X (Twitter) is additionally an <strong>upper bound</strong>: X charges a repeat read of
            the same resource within a UTC day only once, and we do not track resource ids.
          </>
        )}
      </Alert>

      {providerTotalIsUndercount(provider) && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="undercount-caveat">
          ElevenLabs, 2captcha and Placid are not metered yet (ENG-698), so an all-vendor total is
          an <strong>undercount</strong>.
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
                <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }} data-testid="users-with-spend">
                  {(agg?.userCount ?? rows.length).toLocaleString()}
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

          {/* An X-only cut. Under "all" the X rows are in scope so it still
              renders, and the heading says which spend it covers. */}
          {(provider === TWITTER_PROVIDER_KEY || provider === "all") && (
            <XAccountTable accounts={xAccounts} />
          )}
        </>
      )}
    </Box>
  );
}
