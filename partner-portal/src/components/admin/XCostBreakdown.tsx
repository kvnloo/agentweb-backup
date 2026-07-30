import React from "react";
import {
  Alert,
  Box,
  Grid,
  LinearProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import InfoIcon from "@mui/icons-material/InfoOutlined";

// Mirrors the backend GET /api/admin/users/:userId/usage/x-breakdown response
// (usageAnalyticsService.getUserXBreakdown). Every dollar figure is
// server-computed from the ledger's stored costMicroUsd — ALLOCATED (X's
// published rate card applied to our call counts; X reports no per-call price).
export interface XOperationRow {
  operation: string;
  callCount: number;
  quantity: number;
  costUsd: number;
}

export interface UserXBreakdown {
  userId: string;
  start: string;
  end: string;
  costUsd: number;
  callCount: number;
  byOperation: XOperationRow[];
}

function usd(n: number): string {
  return `$${(n || 0).toFixed(n < 1 ? 4 : 2)}`;
}

/** "search_tweets" → "search tweets" for a friendlier tool label. */
export function prettyOperation(op: string): string {
  return op.replace(/_/g, " ");
}

export const XCostBreakdown: React.FC<{
  data: UserXBreakdown | null;
  view: "table" | "bars";
}> = ({ data, view }) => {
  if (!data || data.byOperation.length === 0) {
    return (
      <Alert severity="info" data-testid="x-breakdown-empty">
        No X (Twitter) usage recorded for this user in the selected range.
      </Alert>
    );
  }

  const maxCost = Math.max(...data.byOperation.map((o) => o.costUsd), 0);

  return (
    <Box data-testid="x-breakdown">
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Total X cost
              </Typography>
              <Tooltip
                title="X publishes no per-call price, so this applies X's pay-per-use rate card to this user's call counts — an allocated upper-bound estimate, not a billed figure."
                arrow
              >
                <InfoIcon sx={{ fontSize: 14, color: "text.disabled", cursor: "help" }} />
              </Tooltip>
            </Box>
            <Typography variant="h6" data-testid="x-breakdown-total" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {usd(data.costUsd)}{" "}
              <Typography component="span" variant="caption" color="text.secondary">
                allocated
              </Typography>
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={6}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              Total calls
            </Typography>
            <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {data.callCount.toLocaleString()}
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {view === "bars" ? (
        <Box data-testid="x-breakdown-bars">
          {data.byOperation.map((o) => (
            <Box key={o.operation} sx={{ mb: 1.25 }}>
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
            {data.byOperation.map((o) => (
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

export default XCostBreakdown;
