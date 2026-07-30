import React from "react";
import {
  Alert,
  Box,
  Grid,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import InfoIcon from "@mui/icons-material/InfoOutlined";
import { prettyOperation, XOperationRow } from "./XCostBreakdown";

// ── Org-aware X (Twitter) rollup, mirroring the backend GET
// /api/admin/users/:userId/usage/x-org-rollup response (usageAnalyticsService).
// The X sibling of CostBreakdownBody: allocated X spend summed across ALL org
// members, with a per-member breakdown. X is observe-only, so — unlike the LLM
// rollup — there is NO quota/coverage block; every $ is an allocated rate-card
// figure (X publishes no per-call price), never a deducted or billed amount.

export interface XOrgRollupMember {
  userId: string;
  email: string | null;
  orgRole: "owner" | "member" | null;
  isSelected: boolean;
  costUsd: number;
  callCount: number;
  byOperation: XOperationRow[];
}

export interface XOrgUsageRollup {
  userId: string;
  month: string;
  isOrg: boolean;
  ownerUserId: string;
  ownerEmail: string | null;
  selectedIsOwner: boolean;
  selectedRole: "owner" | "member" | null;
  totalCostUsd: number;
  totalCallCount: number;
  members: XOrgRollupMember[];
  byOperation: XOperationRow[];
}

function usd(n: number): string {
  return `$${(n || 0).toFixed(n < 1 ? 4 : 2)}`;
}

export const XCostBreakdownBody: React.FC<{
  rollup: XOrgUsageRollup | null;
  view: "table" | "bars";
}> = ({ rollup, view }) => {
  if (!rollup) return null;

  const { isOrg, members, byOperation, ownerEmail, selectedRole, totalCostUsd, totalCallCount } =
    rollup;
  const isMemberView = isOrg && selectedRole === "member";
  const hasSpend = byOperation.length > 0;
  const maxCost = Math.max(...byOperation.map((o) => o.costUsd), 0);
  const scopeCaption = isOrg ? "across this org (all members)" : "this user";

  return (
    <Box data-testid="x-breakdown">
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6}>
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Total X cost
              </Typography>
              <Tooltip
                title="X publishes no per-call price, so this applies X's pay-per-use rate card to the call counts — an allocated upper-bound estimate, not a billed figure. Observe-only: X spend is not deducted from any cap."
                arrow
              >
                <InfoIcon sx={{ fontSize: 14, color: "text.disabled", cursor: "help" }} />
              </Tooltip>
            </Box>
            <Typography variant="h6" data-testid="x-breakdown-total" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {usd(totalCostUsd)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              all X calls {scopeCaption}
            </Typography>
          </Box>
        </Grid>
        <Grid item xs={6}>
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              Total calls
            </Typography>
            <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {totalCallCount.toLocaleString()}
            </Typography>
          </Box>
        </Grid>
      </Grid>

      {isMemberView && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="x-member-note">
          This user is a member — the figures above are org-wide across all {members.length}{" "}
          member{members.length === 1 ? "" : "s"}
          {ownerEmail ? ` (owner: ${ownerEmail})` : ""}.
        </Alert>
      )}

      {isOrg && members.length > 0 && (
        <Box sx={{ mb: 2 }} data-testid="x-members-table">
          <Typography variant="caption" color="text.secondary">
            X cost by member
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Member</TableCell>
                <TableCell>Role</TableCell>
                <TableCell align="right">Calls</TableCell>
                <TableCell align="right">Cost</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((m) => (
                <TableRow
                  key={m.userId}
                  data-testid={`x-member-row-${m.userId}`}
                  data-selected={m.isSelected ? "true" : "false"}
                  sx={m.isSelected ? { bgcolor: "action.selected" } : undefined}
                >
                  <TableCell>{m.email ?? m.userId}</TableCell>
                  <TableCell>{m.orgRole ?? "—"}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {m.callCount.toLocaleString()}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                    ${m.costUsd.toFixed(4)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      {!hasSpend ? (
        <Alert severity="info" data-testid="x-breakdown-empty">
          No X (Twitter) usage recorded for {isOrg ? "this org" : "this user"} in the selected month.
        </Alert>
      ) : view === "bars" ? (
        <Box data-testid="x-breakdown-bars">
          <Typography variant="caption" color="text.secondary">
            Spend by tool (of {usd(totalCostUsd)} {isOrg ? "org-wide" : ""})
          </Typography>
          {byOperation.map((o) => (
            <Box key={o.operation} sx={{ mt: 1 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.25 }}>
                <Typography variant="body2">{prettyOperation(o.operation)}</Typography>
                <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {usd(o.costUsd)}{" "}
                  <Typography component="span" variant="caption" color="text.secondary">
                    ({o.callCount.toLocaleString()} calls)
                  </Typography>
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={maxCost > 0 ? (o.costUsd / maxCost) * 100 : 0}
                sx={{ height: 8, borderRadius: 1 }}
              />
            </Box>
          ))}
        </Box>
      ) : (
        <Table size="small" data-testid="x-breakdown-table">
          <TableHead>
            <TableRow>
              <TableCell>Tool</TableCell>
              <TableCell align="right">Calls</TableCell>
              <TableCell align="right">Units</TableCell>
              <TableCell align="right">Cost</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {byOperation.map((o) => (
              <TableRow key={o.operation} hover>
                <TableCell>{prettyOperation(o.operation)}</TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {o.callCount.toLocaleString()}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {o.quantity.toLocaleString()}
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {usd(o.costUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
};

export default XCostBreakdownBody;
