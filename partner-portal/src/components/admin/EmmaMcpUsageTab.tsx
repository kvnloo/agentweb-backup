import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Grid,
  IconButton,
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
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import RefreshIcon from "@mui/icons-material/Refresh";
import axios from "axios";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl } from "../../config";

interface McpUsageSummary {
  oauthStarts: number;
  authorizedUsers: number;
  tokenIssuedUsers: number;
  connectionAttempts: number;
  connectedUsers: number;
  toolCalls: number;
  firstUseUsers: number;
  firstUseRate: number;
}

interface McpUsageClient {
  clientType: string;
  oauthStarts: number;
  authorizedUsers: number;
  tokenIssuedUsers: number;
  connectionAttempts: number;
  connectedUsers: number;
  toolCalls: number;
  firstUseUsers: number;
  clientNames: string[];
}

interface McpUsageUser {
  userId: string;
  email?: string;
  companyName?: string;
  oauthAuthorizedAt?: string;
  tokenIssuedAt?: string;
  connectionAttempts: number;
  firstConnectedAt?: string;
  lastConnectedAt?: string;
  toolCalls: number;
  lastUsedAt?: string;
  lastToolName?: string;
  firstUsedAt?: string;
  firstToolName?: string;
  authMethods: string[];
  apiKeyIds: string[];
  clientIds: string[];
  clientNames: string[];
  clientTypes: string[];
}

interface McpUsageReport {
  start: string;
  end: string;
  summary: McpUsageSummary;
  clients: McpUsageClient[];
  users: McpUsageUser[];
}

const CLAUDE_CODE_COMMAND =
  "claude mcp add --scope user --transport http emma https://api.agentweb.pro/mcp";
const CODEX_CONFIG = `[mcp_servers.emma]
url = "https://api.agentweb.pro/mcp"`;
const CODEX_LOGIN_COMMAND = "codex mcp login emma";

function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return formatDateInput(d);
}

function formatTimestamp(value?: string): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatClientType(value: string): string {
  const labels: Record<string, string> = {
    claude_ai: "Claude connector",
    claude_code: "Claude Code",
    codex: "Codex",
    chatgpt: "ChatGPT/OpenAI",
    hermes: "Hermes",
    openclaw: "OpenClaw",
    api_key: "API key",
    unknown: "Unknown",
  };
  return labels[value] || value;
}

function StatCard({ label, value, caption }: { label: string; value: string | number; caption?: string }) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent sx={{ p: 2, "&:last-child": { pb: 2 } }}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h5" component="div" sx={{ mt: 0.5 }}>
          {value}
        </Typography>
        {caption && (
          <Typography variant="caption" color="text.secondary">
            {caption}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export default function EmmaMcpUsageTab() {
  const { token } = useAuth();
  const [start, setStart] = useState(defaultStartDate);
  const [end, setEnd] = useState(() => formatDateInput(new Date()));
  const [report, setReport] = useState<McpUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const statCards = useMemo(() => {
    if (!report) return [];
    const { summary } = report;
    return [
      { label: "OAuth starts", value: summary.oauthStarts, caption: "Authorize/sign-up flow opened" },
      { label: "Authorized users", value: summary.authorizedUsers, caption: "Consent approved" },
      { label: "Token users", value: summary.tokenIssuedUsers, caption: "MCP client received tokens" },
      { label: "Connections", value: summary.connectionAttempts, caption: `${summary.connectedUsers} users connected` },
      { label: "Tool calls", value: summary.toolCalls, caption: "Successful external calls" },
      { label: "First-use users", value: summary.firstUseUsers, caption: "First successful tool call" },
      { label: "First-use rate", value: formatPercent(summary.firstUseRate), caption: "First use / connected users" },
    ];
  }, [report]);

  const loadReport = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get<McpUsageReport>(
        buildApiUrl(`/api/admin/mcp-usage?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setReport(response.data);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.response?.data?.error || err?.message || "Failed to load MCP usage");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h6">Emma MCP usage</Typography>
          <Typography variant="body2" color="text.secondary">
            OAuth setup, MCP connections, and first successful tool calls.
          </Typography>
        </Box>
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={loadReport} disabled={loading}>
          Refresh
        </Button>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              size="small"
              label="Start"
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              size="small"
              label="End"
              type="date"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={12} md={6}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
              <Typography
                component="code"
                sx={{
                  bgcolor: "action.hover",
                  borderRadius: 1,
                  px: 1,
                  py: 0.75,
                  fontSize: 13,
                  overflowX: "auto",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {CLAUDE_CODE_COMMAND}
              </Typography>
              <Tooltip title="Copy Claude Code command">
                <IconButton
                  aria-label="Copy Claude Code command"
                  onClick={() => navigator.clipboard?.writeText(CLAUDE_CODE_COMMAND)}
                  size="small"
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Grid>
        </Grid>
      </Paper>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
            <Typography variant="subtitle2" gutterBottom>
              Claude.ai / Claude Desktop
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Add custom connector URL:
            </Typography>
            <Typography component="code" sx={{ display: "block", mt: 1, fontSize: 13, overflowX: "auto" }}>
              https://api.agentweb.pro/mcp
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
            <Typography variant="subtitle2" gutterBottom>
              Claude Code direct
            </Typography>
            <Typography component="code" sx={{ display: "block", fontSize: 13, overflowX: "auto" }}>
              {CLAUDE_CODE_COMMAND}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
            <Typography variant="subtitle2" gutterBottom>
              Codex
            </Typography>
            <Typography component="pre" sx={{ my: 0, fontSize: 13, overflowX: "auto" }}>
              {CODEX_CONFIG}
            </Typography>
            <Typography component="code" sx={{ display: "block", mt: 1, fontSize: 13, overflowX: "auto" }}>
              {CODEX_LOGIN_COMMAND}
            </Typography>
          </Paper>
        </Grid>
      </Grid>

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
            {statCards.map((stat) => (
              <Grid item xs={12} sm={6} md={2} key={stat.label}>
                <StatCard label={stat.label} value={stat.value} caption={stat.caption} />
              </Grid>
            ))}
          </Grid>

          <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Client</TableCell>
                  <TableCell>Names seen</TableCell>
                  <TableCell align="right">OAuth starts</TableCell>
                  <TableCell align="right">Authorized</TableCell>
                  <TableCell align="right">Connected users</TableCell>
                  <TableCell align="right">Connections</TableCell>
                  <TableCell align="right">Tool calls</TableCell>
                  <TableCell align="right">First-use users</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(report?.clients ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} align="center">
                      <Typography color="text.secondary" sx={{ py: 2 }}>
                        No client source telemetry in this date range.
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  report!.clients.map((client) => (
                    <TableRow key={client.clientType} hover>
                      <TableCell>{formatClientType(client.clientType)}</TableCell>
                      <TableCell>{client.clientNames.length ? client.clientNames.join(", ") : "-"}</TableCell>
                      <TableCell align="right">{client.oauthStarts}</TableCell>
                      <TableCell align="right">{client.authorizedUsers}</TableCell>
                      <TableCell align="right">{client.connectedUsers}</TableCell>
                      <TableCell align="right">{client.connectionAttempts}</TableCell>
                      <TableCell align="right">{client.toolCalls}</TableCell>
                      <TableCell align="right">{client.firstUseUsers}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>

          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>User</TableCell>
                  <TableCell>Company</TableCell>
                  <TableCell>Client</TableCell>
                  <TableCell align="right">Connections</TableCell>
                  <TableCell align="right">Tool calls</TableCell>
                  <TableCell>OAuth authorized</TableCell>
                  <TableCell>Token issued</TableCell>
                  <TableCell>First connected</TableCell>
                  <TableCell>Last tool</TableCell>
                  <TableCell>Auth</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(report?.users ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} align="center">
                      <Typography color="text.secondary" sx={{ py: 3 }}>
                        No Emma MCP usage in this date range.
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  report!.users.map((user) => (
                    <TableRow key={user.userId} hover>
                      <TableCell>
                        <Typography variant="body2">{user.email || user.userId}</Typography>
                        {user.email && (
                          <Typography variant="caption" color="text.secondary">
                            {user.userId}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>{user.companyName || "-"}</TableCell>
                      <TableCell>
                        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                          {(user.clientTypes.length ? user.clientTypes : ["unknown"]).map((type) => (
                            <Chip key={type} label={formatClientType(type)} size="small" />
                          ))}
                        </Box>
                        {user.clientNames.length > 0 && (
                          <Typography variant="caption" color="text.secondary">
                            {user.clientNames.join(", ")}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">{user.connectionAttempts}</TableCell>
                      <TableCell align="right">{user.toolCalls}</TableCell>
                      <TableCell>{formatTimestamp(user.oauthAuthorizedAt)}</TableCell>
                      <TableCell>{formatTimestamp(user.tokenIssuedAt)}</TableCell>
                      <TableCell>{formatTimestamp(user.firstConnectedAt)}</TableCell>
                      <TableCell>
                        {user.lastUsedAt ? (
                          <Box>
                            <Typography variant="body2">{user.lastToolName || user.firstToolName || "Tool call"}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {formatTimestamp(user.lastUsedAt)}
                            </Typography>
                          </Box>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell>
                        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                          {user.authMethods.length === 0 ? (
                            <Chip label="unknown" size="small" />
                          ) : (
                            user.authMethods.map((method) => <Chip key={method} label={method} size="small" />)
                          )}
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Box>
  );
}
