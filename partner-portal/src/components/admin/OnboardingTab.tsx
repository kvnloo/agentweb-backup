/**
 * Admin onboarding inspector — lists every user who started the
 * onboarding flow with their per-step status, artifact counts,
 * timing, and the last 10 onboarding events. Click a row to expand
 * the events log + grab the delegate-as-user URL for deeper poking.
 *
 * Pairs with backend `GET /api/admin/onboarding/users` (added in
 * routes/admin.ts). Read-only — destructive operations live
 * elsewhere. Mounted as a tab inside AdminDashboard so it sits
 * alongside Users / CRM / Funnel etc.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  Link as MuiLink,
  Paper,
  Stack,
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
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import LaunchIcon from "@mui/icons-material/Launch";
import RefreshIcon from "@mui/icons-material/Refresh";
import axios from "axios";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl, CUSTOMER_FRONTEND_URL } from "../../config";

type StepStatus =
  | "idle"
  | "running"
  | "building"
  | "ready"
  | "failed"
  | null;

interface Stage {
  status: StepStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

interface OnboardingUser {
  userId: string;
  email: string;
  createdAt: string;
  companyName: string | null;
  companyUrl: string | null;
  goal: string;
  onboardingStage: string | null;
  stages: Record<string, Stage>;
  counts: {
    icps: number;
    competitors: number;
    adImages: number;
    adCopies: number;
  };
  adImageChatSessionId: string | null;
  attribution: {
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    referrer: string | null;
    landingUrl: string | null;
  };
  events: Array<{
    ts: string | null;
    event: string;
    data: any;
  }>;
  lastEventAt: string | null;
}

const STEPS: Array<{ key: string; label: string }> = [
  { key: "brandBuild", label: "Brand" },
  { key: "icp", label: "ICP" },
  { key: "competitor", label: "Comp" },
  { key: "creativeDir", label: "CD" },
  { key: "adImage", label: "Img" },
  { key: "adCopy", label: "Copy" },
];

function statusColor(
  status: StepStatus
): "default" | "success" | "warning" | "error" | "info" {
  if (status === "ready") return "success";
  if (status === "running" || status === "building") return "info";
  if (status === "failed") return "error";
  return "default";
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function fmtTimeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtCompactJson(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return String(v);
  }
}

const OnboardingTab: React.FC = () => {
  const { token } = useAuth();
  const [users, setUsers] = useState<OnboardingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(buildApiUrl("/api/admin/onboarding/users"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUsers(res.data.users ?? []);
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) void fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      return (
        u.email?.toLowerCase().includes(q) ||
        u.companyName?.toLowerCase().includes(q) ||
        u.userId?.toLowerCase().includes(q) ||
        u.goal?.toLowerCase().includes(q)
      );
    });
  }, [users, search]);

  const toggleExpand = (userId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  return (
    <Box sx={{ py: 1 }}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          Onboarding Inspector
        </Typography>
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small"
          placeholder="Filter by email / company / user id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ width: 360 }}
        />
        <Tooltip title="Refresh">
          <IconButton onClick={fetchUsers} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      {loading && (
        <Stack direction="row" alignItems="center" spacing={2} sx={{ p: 4 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Loading onboarding users…
          </Typography>
        </Stack>
      )}

      {error && !loading && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!loading && !error && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {filtered.length} user{filtered.length === 1 ? "" : "s"} (sorted by
            most-recent activity)
          </Typography>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell />
                  <TableCell>Email</TableCell>
                  <TableCell>Company</TableCell>
                  <TableCell>Goal</TableCell>
                  {STEPS.map((s) => (
                    <TableCell key={s.key} align="center">
                      {s.label}
                    </TableCell>
                  ))}
                  <TableCell align="center">ICPs</TableCell>
                  <TableCell align="center">Comp.</TableCell>
                  <TableCell align="center">Img</TableCell>
                  <TableCell align="center">Copy</TableCell>
                  <TableCell>Last activity</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.map((u) => {
                  const isOpen = expanded.has(u.userId);
                  const delegateUrl = `${CUSTOMER_FRONTEND_URL}/admin/delegate?targetUserId=${encodeURIComponent(u.userId)}`;
                  return (
                    <React.Fragment key={u.userId}>
                      <TableRow
                        hover
                        sx={{ cursor: "pointer" }}
                        onClick={() => toggleExpand(u.userId)}
                      >
                        <TableCell>
                          <IconButton size="small">
                            {isOpen ? (
                              <KeyboardArrowDownIcon fontSize="small" />
                            ) : (
                              <KeyboardArrowRightIcon fontSize="small" />
                            )}
                          </IconButton>
                        </TableCell>
                        <TableCell sx={{ maxWidth: 240 }}>
                          <Typography variant="body2" noWrap title={u.email}>
                            {u.email}
                          </Typography>
                          {u.onboardingStage && (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              stage: {u.onboardingStage}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 200 }}>
                          <Typography variant="body2" noWrap>
                            {u.companyName ?? "—"}
                          </Typography>
                          {u.companyUrl && (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              noWrap
                              sx={{ display: "block" }}
                            >
                              {u.companyUrl}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip size="small" label={u.goal} />
                        </TableCell>
                        {STEPS.map((s) => {
                          const stage = u.stages[s.key];
                          const tip = stage?.error
                            ? `error: ${stage.error}`
                            : stage?.durationMs != null
                              ? `${fmtDuration(stage.durationMs)}`
                              : stage?.status ?? "idle";
                          return (
                            <TableCell key={s.key} align="center">
                              <Tooltip title={tip} arrow>
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  color={statusColor(stage?.status ?? null)}
                                  label={stage?.status ?? "—"}
                                  sx={{ minWidth: 64 }}
                                />
                              </Tooltip>
                            </TableCell>
                          );
                        })}
                        <TableCell align="center">{u.counts.icps}</TableCell>
                        <TableCell
                          align="center"
                          sx={{
                            color:
                              u.counts.competitors === 0 &&
                              u.stages.competitor?.status === "ready"
                                ? "error.main"
                                : "inherit",
                            fontWeight:
                              u.counts.competitors === 0 &&
                              u.stages.competitor?.status === "ready"
                                ? 600
                                : 400,
                          }}
                        >
                          {u.counts.competitors}
                        </TableCell>
                        <TableCell align="center">
                          {u.counts.adImages}
                        </TableCell>
                        <TableCell align="center">
                          {u.counts.adCopies}
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="body2"
                            title={u.lastEventAt ?? ""}
                          >
                            {fmtTimeAgo(u.lastEventAt)}
                          </Typography>
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <MuiLink
                            href={delegateUrl}
                            target="_blank"
                            rel="noreferrer"
                            sx={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            Delegate <LaunchIcon fontSize="inherit" />
                          </MuiLink>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell
                          sx={{ pb: 0, pt: 0, border: 0 }}
                          colSpan={STEPS.length + 8}
                        >
                          <Collapse in={isOpen} unmountOnExit>
                            <Box sx={{ py: 2, px: 1 }}>
                              <Stack
                                direction="row"
                                spacing={4}
                                alignItems="flex-start"
                              >
                                <Box sx={{ flex: 1 }}>
                                  <Typography variant="overline">
                                    Recent events (last {u.events.length})
                                  </Typography>
                                  {u.events.length === 0 ? (
                                    <Typography
                                      variant="body2"
                                      color="text.secondary"
                                    >
                                      No events recorded.
                                    </Typography>
                                  ) : (
                                    <Box
                                      sx={{
                                        fontFamily: "monospace",
                                        fontSize: 12,
                                        whiteSpace: "nowrap",
                                        overflowX: "auto",
                                      }}
                                    >
                                      {u.events.map((e, i) => (
                                        <Box key={i}>
                                          <span style={{ color: "#888" }}>
                                            {e.ts ?? "?"}
                                          </span>{" "}
                                          <strong>{e.event}</strong>{" "}
                                          {fmtCompactJson(e.data)}
                                        </Box>
                                      ))}
                                    </Box>
                                  )}
                                </Box>
                                <Box sx={{ minWidth: 280 }}>
                                  <Typography variant="overline">
                                    Identifiers
                                  </Typography>
                                  <Typography variant="body2">
                                    userId: <code>{u.userId}</code>
                                  </Typography>
                                  <Typography variant="body2">
                                    chat session:{" "}
                                    <code>
                                      {u.adImageChatSessionId ?? "(none)"}
                                    </code>
                                  </Typography>
                                  {(u.attribution.utmSource ||
                                    u.attribution.referrer) && (
                                    <>
                                      <Typography
                                        variant="overline"
                                        sx={{ mt: 1, display: "block" }}
                                      >
                                        Attribution
                                      </Typography>
                                      {u.attribution.utmSource && (
                                        <Typography variant="body2">
                                          utm:{" "}
                                          {u.attribution.utmSource}/
                                          {u.attribution.utmMedium ?? "?"}/
                                          {u.attribution.utmCampaign ?? "?"}
                                        </Typography>
                                      )}
                                      {u.attribution.referrer && (
                                        <Typography variant="body2" noWrap>
                                          ref: {u.attribution.referrer}
                                        </Typography>
                                      )}
                                    </>
                                  )}
                                </Box>
                              </Stack>
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>
                    </React.Fragment>
                  );
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={STEPS.length + 9}>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ textAlign: "center", py: 4 }}
                      >
                        No onboarding users{search ? " match your filter" : ""}.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Box>
  );
};

export default OnboardingTab;
