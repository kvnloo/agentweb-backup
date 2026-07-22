import React from "react";
import {
  Alert,
  Box,
  Grid,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import InfoIcon from "@mui/icons-material/InfoOutlined";

// ── Org-aware cost rollup, mirroring the backend GET
// /api/admin/users/:userId/usage/org-rollup response (usageAnalyticsService).
// All dollar figures are server-computed: gross burn is summed across ALL org
// members, and "counted" is the org OWNER's quota counter — the fix for the
// per-member "false leak" and owner "burn lags" display bugs (ENG-200).

export interface OrgRollupModelRow {
  model: string;
  costUsd: number;
  callCount: number;
  totalTokens: number;
}

export interface OrgRollupMember {
  userId: string;
  email: string | null;
  orgRole: "owner" | "member" | null;
  isSelected: boolean;
  burnUsd: number;
  callCount: number;
  totalTokens: number;
  byModel: OrgRollupModelRow[];
}

export interface OrgUsageRollup {
  userId: string;
  month: string;
  isOrg: boolean;
  ownerUserId: string;
  ownerEmail: string | null;
  ownerSubscriptionType: string | null;
  selectedIsOwner: boolean;
  selectedRole: "owner" | "member" | null;
  grossBurnUsd: number;
  countedUsd: number;
  countedSource: "current" | "history" | "none";
  unchargedUsd: number;
  coveragePct: number;
  members: OrgRollupMember[];
  byModel: OrgRollupModelRow[];
}

// Caption paired with a hover-help info icon (self-contained copy so this
// component has no dependency on the AdminDashboard page module).
const HelpCaption: React.FC<{ label: string; help: string }> = ({ label, help }) => (
  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
    <Typography variant="caption" color="text.secondary">
      {label}
    </Typography>
    <Tooltip title={help} arrow>
      <InfoIcon sx={{ fontSize: 14, color: "text.disabled", cursor: "help" }} />
    </Tooltip>
  </Box>
);

export const CostBreakdownBody: React.FC<{
  rollup: OrgUsageRollup;
  view: "table" | "bars";
  costAllowanceMap: Record<string, number | null>;
}> = ({ rollup, view, costAllowanceMap }) => {
  const {
    grossBurnUsd: burn,
    countedUsd: counted,
    unchargedUsd: uncharged,
    coveragePct,
    isOrg,
    members,
    byModel,
    ownerEmail,
    ownerSubscriptionType,
    selectedRole,
  } = rollup;

  const isMemberView = isOrg && selectedRole === "member";
  const hasBurn = byModel.length > 0;
  // Counter can run ahead of per-call burn (tracking started more recently than
  // the counter) — a benign timing artifact, shown as info, never as a leak.
  const counterAhead = counted > burn + 0.005;

  // Org cost cap is keyed on the OWNER's tier, not the (possibly different) member's.
  const costAllowance = costAllowanceMap[ownerSubscriptionType || "Basic"] ?? null;
  const quotaPct =
    costAllowance != null && costAllowance > 0 ? (counted / costAllowance) * 100 : null;
  const quotaColor =
    quotaPct == null
      ? "grey.500"
      : quotaPct >= 100
      ? "error.main"
      : quotaPct >= 80
      ? "warning.main"
      : "success.main";

  const totalCalls = byModel.reduce((s, m) => s + m.callCount, 0);
  const totalTokens = byModel.reduce((s, m) => s + m.totalTokens, 0);
  const scopeCaption = isOrg ? "across this org (all members)" : "this user";

  return (
    <>
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={4}>
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
            <HelpCaption
              label="Gross burn"
              help="The real dollar cost of every LLM call — including calls the platform absorbs (burn-only features like deep research). This is what it actually costs us to serve, before any quota accounting. Summed across all org members."
            />
            <Typography
              variant="h6"
              data-testid="rollup-gross"
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              ${burn.toFixed(2)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              all LLM calls {scopeCaption}
            </Typography>
          </Box>
        </Grid>
        <Grid item xs={4}>
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
            <HelpCaption
              label="Counted to quota"
              help="The portion of burn charged against the monthly cost cap. For an org this is the OWNER's counter — every member's chargeable spend is deducted onto the owner. Burn-only calls never deduct, so this is usually ≤ gross burn."
            />
            <Typography
              variant="h6"
              data-testid="rollup-counted"
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              ${counted.toFixed(2)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {isOrg ? "charged to the org owner's cap" : "deducted from their cost cap"}
            </Typography>
          </Box>
        </Grid>
        <Grid item xs={4}>
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
            <HelpCaption
              label="Charged coverage"
              help="Share of gross burn that was charged to quota. The remainder is burn-only features (deep research, drafts, background jobs) the platform absorbs by design, plus any usage predating per-call tracking — not a leak."
            />
            <Typography
              variant="h6"
              data-testid="rollup-coverage"
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              {hasBurn ? `${Math.round(coveragePct)}%` : "—"}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              data-testid="rollup-uncharged"
            >
              ${uncharged.toFixed(2)} not charged (burn-only + pre-tracking)
            </Typography>
          </Box>
        </Grid>
      </Grid>

      {isMemberView && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="member-charged-note">
          This user is a member — their LLM spend is charged to the org owner
          {ownerEmail ? ` (${ownerEmail})` : ""}, not to their own cap. The figures above
          are org-wide across all {members.length} member{members.length === 1 ? "" : "s"}.
        </Alert>
      )}

      {view === "bars" &&
        (costAllowance != null ? (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
              <Typography variant="body2" fontWeight={600}>
                Monthly cost quota{isOrg ? " (org owner)" : ""}
              </Typography>
              <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
                ${counted.toFixed(2)} / ${costAllowance.toFixed(2)} ({Math.round(quotaPct ?? 0)}%)
              </Typography>
            </Box>
            <Tooltip
              title={`${Math.round(
                quotaPct ?? 0
              )}% of the monthly cost cap consumed (counted spend vs the owner's cap)`}
            >
              <Box
                data-testid="quota-bar"
                data-pct={String(Math.min(100, Math.round(quotaPct ?? 0)))}
                sx={{ height: 12, borderRadius: 6, bgcolor: "grey.200", overflow: "hidden" }}
              >
                <Box
                  sx={{
                    height: "100%",
                    width: `${Math.min(100, quotaPct ?? 0)}%`,
                    bgcolor: quotaColor,
                    transition: "width .3s",
                  }}
                />
              </Box>
            </Tooltip>
          </Box>
        ) : (
          <Alert severity="info" sx={{ mb: 2 }}>
            {isOrg ? "This org owner's tier" : "This user's tier"} has no cost cap (unlimited)
            — no quota bar. Per-model spend share is shown below.
          </Alert>
        ))}

      {counterAhead && hasBurn && (
        <Alert severity="info" sx={{ mb: 1 }} data-testid="counter-ahead-note">
          The quota counter is ahead of per-call burn tracking (per-call tracking started
          more recently than the counter), so counted exceeds recorded burn this month.
          This is a tracking-window artifact, not a billing error.
        </Alert>
      )}

      {isOrg && members.length > 0 && (
        <Box sx={{ mb: 2 }} data-testid="members-table">
          <Typography variant="caption" color="text.secondary">
            Burn by member
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Member</TableCell>
                <TableCell>Role</TableCell>
                <TableCell align="right">Calls</TableCell>
                <TableCell align="right">Tokens</TableCell>
                <TableCell align="right">Burn</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((m) => (
                <TableRow
                  key={m.userId}
                  data-testid={`member-row-${m.userId}`}
                  data-selected={m.isSelected ? "true" : "false"}
                  sx={m.isSelected ? { bgcolor: "action.selected" } : undefined}
                >
                  <TableCell>{m.email ?? m.userId}</TableCell>
                  <TableCell>{m.orgRole ?? "—"}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {m.callCount.toLocaleString()}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {m.totalTokens.toLocaleString()}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    ${m.burnUsd.toFixed(4)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      {!hasBurn ? (
        <Alert severity="info" sx={{ mb: 1 }}>
          No per-model burn has been recorded for this month yet. Burn is captured per LLM
          call from usage records, so an empty view means no metered calls landed in this
          window. The “Counted to quota” figure comes from a separate running counter and
          may still be non-zero.
        </Alert>
      ) : view === "bars" ? (
        <Box data-testid="cost-breakdown-bars">
          <Typography variant="caption" color="text.secondary">
            Spend share by model (of ${burn.toFixed(2)} gross burn)
          </Typography>
          {byModel.map((m) => {
            const share = burn > 0 ? (m.costUsd / burn) * 100 : 0;
            return (
              <Box key={m.model} sx={{ mt: 1 }} data-testid={`bar-${m.model}`} data-share={share.toFixed(1)}>
                <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                  <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
                    {m.model}
                  </Typography>
                  <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    ${m.costUsd.toFixed(4)} ({share.toFixed(1)}%)
                  </Typography>
                </Box>
                <Box sx={{ height: 8, borderRadius: 4, bgcolor: "grey.100", overflow: "hidden" }}>
                  <Box
                    sx={{ height: "100%", width: `${Math.max(share, 0.5)}%`, bgcolor: "primary.main" }}
                  />
                </Box>
              </Box>
            );
          })}
        </Box>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Model</TableCell>
              <TableCell align="right">Calls</TableCell>
              <TableCell align="right">Tokens</TableCell>
              <TableCell align="right">Burn</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {byModel.map((m) => (
              <TableRow key={m.model}>
                <TableCell>{m.model}</TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {m.callCount.toLocaleString()}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {m.totalTokens.toLocaleString()}
                </TableCell>
                <TableCell
                  align="right"
                  data-testid={`burn-${m.model}`}
                  sx={{ fontVariantNumeric: "tabular-nums" }}
                >
                  ${m.costUsd.toFixed(4)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>Total</TableCell>
              <TableCell align="right" sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {totalCalls.toLocaleString()}
              </TableCell>
              <TableCell align="right" sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {totalTokens.toLocaleString()}
              </TableCell>
              <TableCell align="right" sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                ${burn.toFixed(4)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </>
  );
};

export default CostBreakdownBody;
