import React, { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Grid,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import axios from "axios";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl } from "../../config";

// ENG-2902: GET /api/admin/zoma/scoreboard (definitions live in backend services/zomaScoreboard.ts).
interface FirstAdLive {
  at: string;
  approvedAt: string;
  campaignId: string;
  platform: string;
  effectiveStatus: string;
  impressions: number;
}

interface ScoreboardRow {
  userId: string;
  email: string;
  excluded?: "internal" | "test" | "pal";
  signupRef?: string;
  zomaStage?: string;
  createdAt?: string;
  lastSuccessfulWriteAt?: string;
  writes7d: { create: number; edit: number; pause: number; approve: number; total: number };
  active7d: boolean;
  firstAdLive?: FirstAdLive;
  goLiveApprovalsAwaitingProof: number;
}

interface Scoreboard {
  generatedAt: string;
  activeWindowDays: number;
  definitions: { active: string; firstSuccessfulAd: string; excluded: string };
  summary: { zomaUsers: number; activeUsers7d: number; firstAdUsers: number; excludedAccounts: number; palUsers?: number };
  rows: ScoreboardRow[];
}

interface FirstAdResult {
  userId: string;
  outcome: string;
}

function formatTimestamp(value?: string): string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
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

export default function ZomaScoreboardTab() {
  const { token } = useAuth();
  const [board, setBoard] = useState<Scoreboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const headers = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get<Scoreboard>(buildApiUrl("/api/admin/zoma/scoreboard"), { headers });
      setBoard(response.data);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "Failed to load Zoma scoreboard");
    } finally {
      setLoading(false);
    }
  };

  const verifyFirstAds = async () => {
    setVerifying(true);
    setVerifyNote(null);
    setError(null);
    try {
      const response = await axios.post<{ results: FirstAdResult[] }>(
        buildApiUrl("/api/admin/zoma/scoreboard/verify-first-ads"), {}, { headers },
      );
      const counts = response.data.results.reduce<Record<string, number>>((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      }, {});
      const parts = Object.entries(counts).map(([outcome, n]) => `${outcome}: ${n}`);
      setVerifyNote(parts.length ? parts.join(", ") : "No go-live approvals to check");
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "First-ad check failed");
    } finally {
      setVerifying(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h6">Zoma scoreboard</Typography>
          <Typography variant="body2" color="text.secondary">
            Per-user Zoma activity. Team and test accounts are listed but not counted.
          </Typography>
        </Box>
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button variant="outlined" onClick={verifyFirstAds} disabled={verifying || loading}>
            {verifying ? "Checking…" : "Check first ads"}
          </Button>
          <Button startIcon={<RefreshIcon />} variant="outlined" onClick={load} disabled={loading}>
            Refresh
          </Button>
        </Box>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {verifyNote && <Alert severity="info" sx={{ mb: 2 }}>{verifyNote}</Alert>}

      {loading && !board ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : board ? (
        <>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={12} sm={4}>
              <StatCard label="Zoma users" value={board.summary.zomaUsers} caption={`${board.summary.excludedAccounts} team/test/pal excluded${board.summary.palUsers ? ` (${board.summary.palUsers} pal${board.summary.palUsers === 1 ? "" : "s"})` : ""}`} />
            </Grid>
            <Grid item xs={12} sm={4}>
              <StatCard label={`Active (${board.activeWindowDays}d)`} value={board.summary.activeUsers7d} caption={board.definitions.active} />
            </Grid>
            <Grid item xs={12} sm={4}>
              <StatCard label="First successful ad" value={board.summary.firstAdUsers} caption={board.definitions.firstSuccessfulAd} />
            </Grid>
          </Grid>

          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>User</TableCell>
                  <TableCell>Stage</TableCell>
                  <TableCell>Active (7d)</TableCell>
                  <TableCell align="right">Create</TableCell>
                  <TableCell align="right">Edit</TableCell>
                  <TableCell align="right">Pause</TableCell>
                  <TableCell align="right">Approve</TableCell>
                  <TableCell>Last write</TableCell>
                  <TableCell>First successful ad</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {board.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9}>No Zoma users yet.</TableCell>
                  </TableRow>
                )}
                {board.rows.map((row) => (
                  <TableRow key={row.userId} sx={row.excluded ? { opacity: 0.55 } : undefined}>
                    <TableCell>
                      {row.email}
                      {row.excluded && <Chip size="small" label={row.excluded === "internal" ? "team" : row.excluded} sx={{ ml: 1 }} />}
                      {row.signupRef && (
                        <Typography variant="caption" color="text.secondary" display="block">ref {row.signupRef}</Typography>
                      )}
                    </TableCell>
                    <TableCell>{row.zomaStage ?? "-"}</TableCell>
                    <TableCell>{row.active7d ? "Yes" : "No"}</TableCell>
                    <TableCell align="right">{row.writes7d.create}</TableCell>
                    <TableCell align="right">{row.writes7d.edit}</TableCell>
                    <TableCell align="right">{row.writes7d.pause}</TableCell>
                    <TableCell align="right">{row.writes7d.approve}</TableCell>
                    <TableCell>{formatTimestamp(row.lastSuccessfulWriteAt)}</TableCell>
                    <TableCell>
                      {row.firstAdLive ? (
                        <>
                          {formatTimestamp(row.firstAdLive.at)}
                          <Typography variant="caption" color="text.secondary" display="block">
                            campaign {row.firstAdLive.campaignId} · {row.firstAdLive.impressions} impressions
                          </Typography>
                        </>
                      ) : row.goLiveApprovalsAwaitingProof > 0 ? (
                        `${row.goLiveApprovalsAwaitingProof} approval(s) awaiting proof`
                      ) : (
                        "-"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            Generated {formatTimestamp(board.generatedAt)}. {board.definitions.excluded}
          </Typography>
        </>
      ) : null}
    </Box>
  );
}
