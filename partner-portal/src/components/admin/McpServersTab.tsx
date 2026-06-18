import React, { Component, useEffect, useState } from "react";
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  IconButton,
  Collapse,
  Tooltip,
} from "@mui/material";
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  VpnKey as KeyIcon,
  Autorenew as AutorenewIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl } from "../../config";

// Tokens are proactively refreshed once they're within this window of expiry
// (must match OAUTH_REFRESH_LEAD_MS on the backend).
const OAUTH_REFRESH_LEAD_MS = 5 * 60 * 1000;
// How often to silently re-fetch servers so the countdown reflects refreshed tokens.
const SERVER_POLL_MS = 30 * 1000;

// Format a millisecond duration as a compact countdown, e.g. "1h 4m", "4m 12s", "9s".
const formatDuration = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

// Validation constants
const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const isValidServerName = (name: string): boolean => NAME_REGEX.test(name);
const isValidUrl = (urlString: string): boolean => {
  if (!urlString) return true; // Empty is handled by required check
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

// Error Boundary
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class McpServersErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box p={4}>
          <Alert severity="error">
            Something went wrong loading MCP Servers. Please refresh the page.
          </Alert>
        </Box>
      );
    }
    return this.props.children;
  }
}

interface McpServer {
  name: string;
  transport: "sse" | "streamable-http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  accessToken?: string;
  isInternal?: boolean;
  discoveredTools?: string[];
  authType?: "none" | "bearer" | "oauth";
  oauthExpiresAt?: number;
  oauthHasRefreshToken?: boolean;
}

// Renders a compact, live "auto-refresh" countdown chip for an OAuth server.
// The chip stays narrow (short label) with the full status in a tooltip, so it
// doesn't widen the table column; aria-label carries the full text.
const OAuthCountdown: React.FC<{ expiresAt: number; canRefresh?: boolean; now: number }> = ({
  expiresAt,
  canRefresh,
  now,
}) => {
  const nextRefreshIn = expiresAt - OAUTH_REFRESH_LEAD_MS - now;
  const expiresIn = expiresAt - now;

  let short: string;
  let full: string;
  let color: "success" | "warning" | "error";
  if (!canRefresh && expiresIn <= 0) {
    short = "Re-authorize";
    full = "Token expired — click the key icon to re-authorize";
    color = "error";
  } else if (nextRefreshIn > 0) {
    short = formatDuration(nextRefreshIn);
    full = `Auto-refresh in ${short}`;
    color = "success";
  } else if (expiresIn > 0) {
    short = "Refreshing…";
    full = "Refreshing token…";
    color = "warning";
  } else if (canRefresh) {
    short = "Refreshing…";
    full = "Refreshing token…";
    color = "warning";
  } else {
    short = "Expired";
    full = "Token expired — click the key icon to re-authorize";
    color = "error";
  }

  return (
    <Tooltip title={full}>
      <Chip
        aria-label={full}
        icon={<AutorenewIcon sx={{ fontSize: 14 }} />}
        label={short}
        size="small"
        variant="outlined"
        color={color}
        sx={{
          mt: 0.5,
          height: 22,
          maxWidth: "100%",
          "& .MuiChip-label": { px: 0.75, fontSize: "0.7rem" },
          "& .MuiChip-icon": { ml: 0.5, mr: -0.25 },
        }}
      />
    </Tooltip>
  );
};

interface OAuthFlowResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}



const McpServersTab: React.FC = () => {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  
  // Dialog states
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [serverToEdit, setServerToEdit] = useState<McpServer | null>(null);
  const [serverToDelete, setServerToDelete] = useState<string | null>(null);
  
  // Form state
  const [formData, setFormData] = useState<Partial<McpServer>>({
    name: "",
    transport: "streamable-http",
    url: "",
    command: "",
    accessToken: "",
    isInternal: false,
  });
  const [argsInput, setArgsInput] = useState("");
  const [configInput, setConfigInput] = useState("");
  const [formLoading, setFormLoading] = useState(false);
  
  // Tool discovery state
  const [discoveryLoading, setDiscoveryLoading] = useState<string | null>(null);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  // OAuth authorization state (server name currently being authorized)
  const [authorizingServer, setAuthorizingServer] = useState<string | null>(null);
  // Ticking clock that drives the live OAuth countdowns.
  const [now, setNow] = useState<number>(() => Date.now());

  const { token } = useAuth();

  // Opens the OAuth provider's login page in a popup and resolves once the
  // backend callback posts a result message back (or the popup is closed).
  const openOAuthPopup = (authorizationUrl: string): Promise<OAuthFlowResult> =>
    new Promise((resolve) => {
      const popup = window.open(authorizationUrl, "mcp-oauth", "width=600,height=720");
      if (!popup) {
        resolve({ ok: false, error: "Popup blocked. Allow popups and try again." });
        return;
      }
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        clearInterval(timer);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.data && event.data.source === "mcp-oauth") {
          cleanup();
          resolve({ ok: !!event.data.success, error: event.data.error });
        }
      };
      window.addEventListener("message", onMessage);
      const timer = setInterval(() => {
        if (popup.closed) {
          cleanup();
          resolve({ ok: false, error: "Authorization window was closed before completing." });
        }
      }, 800);
    });

  // Asks the backend whether the server needs OAuth; if so, runs the popup flow.
  // Returns skipped:true when the server connects without interactive auth.
  const runOAuthFlow = async (serverName: string): Promise<OAuthFlowResult> => {
    const response = await axios.post(
      buildApiUrl(`/api/admin/mcp-servers/${encodeURIComponent(serverName)}/oauth/initiate`),
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.data?.authorizationRequired) {
      return { ok: true, skipped: true };
    }
    return openOAuthPopup(response.data.authorizationUrl);
  };

  const handleAuthorize = async (server: McpServer) => {
    try {
      setAuthorizingServer(server.name);
      setError("");
      setSuccess("");
      const result = await runOAuthFlow(server.name);
      if (result.skipped) {
        setSuccess(`${server.name} connected — no OAuth required.`);
        await handleDiscoverTools(server.name);
      } else if (result.ok) {
        setSuccess(`Authorized ${server.name} successfully.`);
        await handleDiscoverTools(server.name);
      } else {
        setError(`Authorization failed: ${result.error || "Unknown error"}`);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to start authorization");
    } finally {
      setAuthorizingServer(null);
    }
  };

  const isHttpTransport =
    formData.transport === "streamable-http" || formData.transport === "sse";
  const isStdioTransport = formData.transport === "stdio";
  const hasInvalidName = !!formData.name && !isValidServerName(formData.name);
  const hasInvalidUrl = isHttpTransport && !!formData.url && !isValidUrl(formData.url);
  const missingRequiredUrl = isHttpTransport && !formData.url?.trim();
  const missingRequiredCommand = isStdioTransport && !formData.command?.trim();
  const isFormInvalid =
    !formData.name ||
    hasInvalidName ||
    hasInvalidUrl ||
    missingRequiredUrl ||
    missingRequiredCommand;

  useEffect(() => {
    loadServers();
  }, []);

  // Tick every second so OAuth countdowns stay live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Silently re-fetch servers periodically so refreshed token expiries show up.
  useEffect(() => {
    const id = setInterval(() => loadServers(true), SERVER_POLL_MS);
    return () => clearInterval(id);
  }, []);

  const loadServers = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      if (!silent) setError("");
      const response = await axios.get(buildApiUrl("/api/admin/mcp-servers"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setServers(response.data);
    } catch (err: any) {
      if (!silent) setError(err.response?.data?.message || "Failed to load MCP servers");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleDiscoverTools = async (serverName: string) => {
    try {
      setDiscoveryLoading(serverName);
      setError("");
      const response = await axios.post(
        buildApiUrl(`/api/admin/mcp-servers/${encodeURIComponent(serverName)}/discover-tools`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setExpandedServer(serverName);
      setSuccess(
        response.data.message && response.data.count === 0
          ? response.data.message
          : `Discovered ${response.data.count} tools from ${serverName}`
      );
      loadServers(); // Reload to get updated discoveredTools
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to discover tools from ${serverName}`);
    } finally {
      setDiscoveryLoading(null);
    }
  };

  const handleAddServer = async () => {
    try {
      setFormLoading(true);
      setError("");
      
      let parsedArgs: string[] | undefined;
      if (argsInput.trim()) {
        parsedArgs = argsInput.split('\n').map(a => a.trim()).filter(a => a);
      }
      
      let parsedConfig: Record<string, any> = {};
      if (configInput.trim()) {
        try {
          parsedConfig = JSON.parse(configInput);
        } catch (e) {
          setError("Invalid JSON for Additional Configuration");
          setFormLoading(false);
          return;
        }
      }

      const finalPayload = formData.transport === "stdio"
        ? {
            ...parsedConfig,
            name: formData.name,
            transport: formData.transport,
            command: formData.command,
            args: parsedArgs,
            isInternal: formData.isInternal,
          }
        : {
            ...parsedConfig,
            name: formData.name,
            transport: formData.transport,
            url: formData.url,
            accessToken: formData.accessToken,
            isInternal: formData.isInternal,
          };

      await axios.post(buildApiUrl("/api/admin/mcp-servers"), finalPayload, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // Don't set success message here yet, wait for discovery
      // setSuccess("Server added successfully");
      setAddDialogOpen(false);
      const newServerName = formData.name!; // Name is required in form
      const isHttpServer = formData.transport !== "stdio";
      resetForm();

      // Auto-discover tools
      // We keep formLoading true while discovering? Or maybe separate loading state?
      // existing handleDiscoverTools sets discoveryLoading
      setFormLoading(false); // Valid to clear form loading as dialog is closed

      // For HTTP servers, detect whether the server needs OAuth. If it does, run
      // the login popup before discovering tools. The system decides based on the
      // server's own response — no manual auth-type selection needed.
      if (isHttpServer) {
        try {
          const result = await runOAuthFlow(newServerName);
          if (!result.ok && !result.skipped) {
            setError(
              `Server added, but authorization failed: ${result.error || "Unknown error"}. Use the key icon to retry.`
            );
            loadServers();
            return;
          }
          if (result.ok && !result.skipped) {
            setSuccess(`Authorized ${newServerName} successfully.`);
          }
        } catch (err: any) {
          setError(
            `Server added, but the authorization check failed: ${err.response?.data?.message || err.message}. Use the key icon to retry.`
          );
          loadServers();
          return;
        }
      }

      await handleDiscoverTools(newServerName);

      // loadServers is called inside handleDiscoverTools

    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to add server");
      setFormLoading(false);
    }
  };

  const handleEditServer = async () => {
    if (!serverToEdit) return;
    try {
      setFormLoading(true);
      setError("");
      let parsedArgs: string[] | undefined;
      if (argsInput.trim()) {
        parsedArgs = argsInput.split('\n').map(a => a.trim()).filter(a => a);
      }
      
      let parsedConfig: Record<string, any> = {};
      if (configInput.trim()) {
        try {
          parsedConfig = JSON.parse(configInput);
        } catch (e) {
          setError("Invalid JSON for Additional Configuration");
          setFormLoading(false);
          return;
        }
      }

      const payload = formData.transport === "stdio"
        ? {
            ...parsedConfig,
            name: formData.name,
            transport: formData.transport,
            command: formData.command,
            args: parsedArgs,
            isInternal: formData.isInternal,
          }
        : {
            ...parsedConfig,
            name: formData.name,
            transport: formData.transport,
            url: formData.url,
            accessToken: formData.accessToken,
            isInternal: formData.isInternal,
          };

      await axios.put(
        buildApiUrl(`/api/admin/mcp-servers/${encodeURIComponent(serverToEdit.name)}`),
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess("Server updated successfully");
      setEditDialogOpen(false);
      resetForm();
      loadServers();
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to update server");
    } finally {
      setFormLoading(false);
    }
  };

  const handleDeleteServer = async () => {
    if (!serverToDelete) return;
    try {
      setFormLoading(true);
      setError("");
      await axios.delete(
        buildApiUrl(`/api/admin/mcp-servers/${encodeURIComponent(serverToDelete)}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess("Server deleted successfully");
      setDeleteDialogOpen(false);
      setServerToDelete(null);
      loadServers();
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to delete server");
    } finally {
      setFormLoading(false);
    }
  };



  const resetForm = () => {
    setFormData({
      name: "",
      transport: "streamable-http",
      url: "",
      command: "",
      accessToken: "",
      isInternal: false,
    });
    setArgsInput("");
    setConfigInput("");
    setServerToEdit(null);
  };

  const openEditDialog = (server: McpServer) => {
    setServerToEdit(server);
    setFormData({
      name: server.name,
      transport: server.transport,
      url: server.url || "",
      command: server.command || "",
      accessToken: server.accessToken || "",
      isInternal: server.isInternal || false,
    });
    setArgsInput(server.args ? server.args.join('\n') : "");
    
    // Extract everything that ISN'T in the main form fields to populate configInput?
    // Or just show env? User specifically asked for this to "make json complete".
    // For now, let's just dump 'env' and any other unknown keys if we could know them.
    // Given the type definition, we only really know 'env'.
    // Let's just put 'env' in there for now as a default start.
    const additionalConfig = {
        env: server.env
    };
    setConfigInput(server.env ? JSON.stringify(additionalConfig, null, 2) : "");
    setEditDialogOpen(true);
  };

  const openDeleteDialog = (serverName: string) => {
    setServerToDelete(serverName);
    setDeleteDialogOpen(true);
  };

  const toggleExpand = (serverName: string) => {
    setExpandedServer(expandedServer === serverName ? null : serverName);
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">MCP Servers</Typography>
        <Box>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => loadServers()}
            sx={{ mr: 1 }}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              resetForm();
              setAddDialogOpen(true);
            }}
          >
            Add Server
          </Button>
        </Box>
      </Box>

      <Alert severity="info" sx={{ mb: 2 }}>
        Adding, editing, or deleting MCP servers will restart the Agent Mode worker process. Prefer making these changes during non-rush hours to reduce disruption.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError("")}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess("")}>
          {success}
        </Alert>
      )}

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Transport</TableCell>
              <TableCell>URL / Command</TableCell>
              <TableCell>Tools</TableCell>

              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {servers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center">
                  <Typography color="textSecondary">
                    No MCP servers configured
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              servers.map((server) => (
                <React.Fragment key={server.name}>
                  <TableRow>
                    <TableCell>
                      <Box display="flex" alignItems="center">
                        <IconButton
                          size="small"
                          onClick={() => toggleExpand(server.name)}
                        >
                          {expandedServer === server.name ? (
                            <ExpandLessIcon />
                          ) : (
                            <ExpandMoreIcon />
                          )}
                        </IconButton>
                        <Typography sx={{ ml: 1 }}>{server.name}</Typography>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Box display="flex" flexDirection="column" alignItems="flex-start">
                        <Chip
                          label={server.transport}
                          size="small"
                          color={
                            server.transport === "streamable-http"
                              ? "primary"
                              : server.transport === "sse"
                              ? "secondary"
                              : server.transport === "stdio"
                              ? "success"
                              : "default"
                          }
                        />
                        {server.authType === "oauth" && typeof server.oauthExpiresAt === "number" && (
                          <OAuthCountdown
                            expiresAt={server.oauthExpiresAt}
                            canRefresh={server.oauthHasRefreshToken}
                            now={now}
                          />
                        )}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {server.transport === "stdio"
                          ? server.command || server.url || "-"
                          : server.url || server.command || "-"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => handleDiscoverTools(server.name)}
                        disabled={discoveryLoading === server.name}
                        startIcon={
                          discoveryLoading === server.name ? (
                            <CircularProgress size={16} />
                          ) : null
                        }
                      >
                        {server.discoveredTools?.length || 0} Tools
                      </Button>
                    </TableCell>

                    <TableCell sx={{ whiteSpace: "nowrap" }}>
                      {(server.transport === "streamable-http" || server.transport === "sse") && (
                        <IconButton
                          size="small"
                          onClick={() => handleAuthorize(server)}
                          title={server.authType === "oauth" ? "Re-authorize (OAuth)" : "Authorize / connect"}
                          color={server.authType === "oauth" ? "success" : "default"}
                          disabled={authorizingServer === server.name}
                        >
                          {authorizingServer === server.name ? <CircularProgress size={16} /> : <KeyIcon />}
                        </IconButton>
                      )}
                      <IconButton
                        size="small"
                        onClick={() => openEditDialog(server)}
                        title="Edit"
                      >
                        <EditIcon />
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={() => openDeleteDialog(server.name)}
                        title="Delete"
                        color="error"
                      >
                        <DeleteIcon />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={5} sx={{ py: 0 }}>
                      <Collapse in={expandedServer === server.name}>
                        <Box sx={{ p: 2, bgcolor: "grey.50" }}>
                          <Typography variant="subtitle2" gutterBottom>
                            Discovered Tools ({server.discoveredTools?.length || 0})
                          </Typography>
                          {server.discoveredTools && server.discoveredTools.length > 0 ? (
                            <Box display="flex" flexWrap="wrap" gap={1}>
                              {server.discoveredTools.map((tool) => (
                                <Chip
                                  key={tool}
                                  label={tool}
                                  size="small"
                                  variant="outlined"
                                />
                              ))}
                            </Box>
                          ) : (
                            <Typography color="textSecondary" variant="body2">
                              Click "Tools" button to discover available tools
                            </Typography>
                          )}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Add Server Dialog */}
      <Dialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add MCP Server</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2} mt={1}>
            <TextField
              label="Server Name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              fullWidth
              required
              error={!!formData.name && !isValidServerName(formData.name)}
              helperText={formData.name && !isValidServerName(formData.name) ? "Name must be 1-64 characters, alphanumeric, underscores, or hyphens only" : ""}
            />
            <FormControl fullWidth>
              <InputLabel>Transport Type</InputLabel>
              <Select
                value={formData.transport}
                label="Transport Type"
                onChange={(e) =>
                  setFormData((prev) => {
                    const nextTransport = e.target.value as McpServer["transport"];
                    if (nextTransport === "stdio") {
                      return {
                        ...prev,
                        transport: nextTransport,
                        url: "",
                        accessToken: "",
                      };
                    }
                    return {
                      ...prev,
                      transport: nextTransport,
                      command: "",
                    };
                  })
                }
              >
                <MenuItem value="streamable-http">Streamable HTTP</MenuItem>
                <MenuItem value="sse">SSE (Server-Sent Events)</MenuItem>
                <MenuItem value="stdio">Stdio (Backend launches process)</MenuItem>
              </Select>
            </FormControl>
            {isHttpTransport && (
              <TextField
                label="URL"
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                fullWidth
                required
                placeholder="http://localhost:4000/mcp"
                error={!!formData.url && !isValidUrl(formData.url)}
                helperText={formData.url && !isValidUrl(formData.url) ? "Must be a valid http or https URL" : ""}
              />
            )}
            {isStdioTransport && (
              <>
                <TextField
                  label="Command"
                  value={formData.command}
                  onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                  fullWidth
                  required
                  placeholder="npx"
                />
                <TextField
                  label="Arguments (optional, one per line)"
                  value={argsInput}
                  onChange={(e) => setArgsInput(e.target.value)}
                  fullWidth
                  multiline
                  minRows={3}
                  placeholder={"-y\n@brave/brave-search-mcp-server\n--transport\nstdio"}
                />
                <TextField
                  label="Environment Variables JSON (optional)"
                  value={configInput}
                  onChange={(e) => setConfigInput(e.target.value)}
                  fullWidth
                  multiline
                  minRows={4}
                  placeholder={'{"env":{"BRAVE_API_KEY":"${BRAVE_API_KEY}"}}'}
                  helperText='Use ${VAR} for server env vars, {{var}} for per-user secrets (configured in Users tab)'
                />
              </>
            )}
            {isHttpTransport && (
              <TextField
                label="Access Token (optional)"
                value={formData.accessToken}
                onChange={(e) => setFormData({ ...formData, accessToken: e.target.value })}
                fullWidth
                type="password"
                placeholder="${MCP_ACCESS_TOKEN}"
                helperText="Leave blank for servers that use OAuth — after adding, a login window opens automatically if the server requires it."
              />
            )}

          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleAddServer}
            variant="contained"
            disabled={formLoading || isFormInvalid}
          >
            {formLoading ? <CircularProgress size={24} /> : "Add"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Server Dialog */}
      <Dialog open={editDialogOpen} onClose={() => setEditDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit MCP Server</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2} mt={1}>
            <TextField
              label="Server Name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              fullWidth
              required
              error={!!formData.name && !isValidServerName(formData.name)}
              helperText={formData.name && !isValidServerName(formData.name) ? "Name must be 1-64 characters, alphanumeric, underscores, or hyphens only" : ""}
            />
            <FormControl fullWidth>
              <InputLabel>Transport Type</InputLabel>
              <Select
                value={formData.transport}
                label="Transport Type"
                onChange={(e) =>
                  setFormData((prev) => {
                    const nextTransport = e.target.value as McpServer["transport"];
                    if (nextTransport === "stdio") {
                      return {
                        ...prev,
                        transport: nextTransport,
                        url: "",
                        accessToken: "",
                      };
                    }
                    return {
                      ...prev,
                      transport: nextTransport,
                      command: "",
                    };
                  })
                }
              >
                <MenuItem value="streamable-http">Streamable HTTP</MenuItem>
                <MenuItem value="sse">SSE (Server-Sent Events)</MenuItem>
                <MenuItem value="stdio">Stdio (Backend launches process)</MenuItem>
              </Select>
            </FormControl>
            {isHttpTransport && (
              <TextField
                label="URL"
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                fullWidth
                required
                error={!!formData.url && !isValidUrl(formData.url)}
                helperText={formData.url && !isValidUrl(formData.url) ? "Must be a valid http or https URL" : ""}
              />
            )}
            {isStdioTransport && (
              <>
                <TextField
                  label="Command"
                  value={formData.command}
                  onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                  fullWidth
                  required
                />
                <TextField
                  label="Arguments (optional, one per line)"
                  value={argsInput}
                  onChange={(e) => setArgsInput(e.target.value)}
                  fullWidth
                  multiline
                  minRows={3}
                />
                <TextField
                  label="Environment Variables JSON (optional)"
                  value={configInput}
                  onChange={(e) => setConfigInput(e.target.value)}
                  fullWidth
                  multiline
                  minRows={4}
                  placeholder={'{"env":{"BRAVE_API_KEY":"${BRAVE_API_KEY}"}}'}
                  helperText='Use ${VAR} for server env vars, {{var}} for per-user secrets (configured in Users tab)'
                />
              </>
            )}
            {isHttpTransport && (
              <TextField
                label="Access Token (optional)"
                value={formData.accessToken}
                onChange={(e) => setFormData({ ...formData, accessToken: e.target.value })}
                fullWidth
                type="password"
              />
            )}

          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleEditServer}
            variant="contained"
            disabled={formLoading || isFormInvalid}
          >
            {formLoading ? <CircularProgress size={24} /> : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete MCP Server</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete the server "{serverToDelete}"?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleDeleteServer}
            color="error"
            variant="contained"
            disabled={formLoading}
          >
            {formLoading ? <CircularProgress size={24} /> : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

// Wrap with Error Boundary
const McpServersTabWithErrorBoundary: React.FC = () => (
  <McpServersErrorBoundary>
    <McpServersTab />
  </McpServersErrorBoundary>
);

export default McpServersTabWithErrorBoundary;
