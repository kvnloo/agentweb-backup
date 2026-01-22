import React, { useEffect, useState } from "react";
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
  FormControlLabel,
  Checkbox,
} from "@mui/material";
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../../contexts/AuthContext";
import { buildApiUrl } from "../../config";

interface McpServer {
  name: string;
  transport: "sse" | "stdio" | "streamable-http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  accessToken?: string;
  isInternal?: boolean;
  discoveredTools?: string[];
}

interface DiscoveredTool {
  name: string;
  description?: string;
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
  const [formLoading, setFormLoading] = useState(false);
  
  // Tool discovery state
  const [discoveryLoading, setDiscoveryLoading] = useState<string | null>(null);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [discoveredTools, setDiscoveredTools] = useState<Record<string, DiscoveredTool[]>>({});
  
  const { token } = useAuth();

  useEffect(() => {
    loadServers();
  }, []);

  const loadServers = async () => {
    try {
      setLoading(true);
      setError("");
      const response = await axios.get(buildApiUrl("/api/admin/mcp-servers"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setServers(response.data);
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  };

  const handleAddServer = async () => {
    try {
      setFormLoading(true);
      setError("");
      await axios.post(buildApiUrl("/api/admin/mcp-servers"), formData, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSuccess("Server added successfully");
      setAddDialogOpen(false);
      resetForm();
      loadServers();
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to add server");
    } finally {
      setFormLoading(false);
    }
  };

  const handleEditServer = async () => {
    if (!serverToEdit) return;
    try {
      setFormLoading(true);
      setError("");
      await axios.put(
        buildApiUrl(`/api/admin/mcp-servers/${encodeURIComponent(serverToEdit.name)}`),
        formData,
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

  const handleDiscoverTools = async (serverName: string) => {
    try {
      setDiscoveryLoading(serverName);
      setError("");
      const response = await axios.post(
        buildApiUrl(`/api/admin/mcp-servers/${encodeURIComponent(serverName)}/discover-tools`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setDiscoveredTools((prev) => ({
        ...prev,
        [serverName]: response.data.tools,
      }));
      setExpandedServer(serverName);
      setSuccess(`Discovered ${response.data.count} tools from ${serverName}`);
      loadServers(); // Reload to get updated discoveredTools
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to discover tools from ${serverName}`);
    } finally {
      setDiscoveryLoading(null);
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
            onClick={loadServers}
            sx={{ mr: 1 }}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setAddDialogOpen(true)}
          >
            Add Server
          </Button>
        </Box>
      </Box>

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
              <TableCell>Internal</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {servers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} align="center">
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
                      <Chip
                        label={server.transport}
                        size="small"
                        color={
                          server.transport === "streamable-http"
                            ? "primary"
                            : server.transport === "sse"
                            ? "secondary"
                            : "default"
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {server.url || server.command || "-"}
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
                    <TableCell>
                      {server.isInternal ? (
                        <Chip label="Yes" size="small" color="info" />
                      ) : (
                        <Chip label="No" size="small" variant="outlined" />
                      )}
                    </TableCell>
                    <TableCell>
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
                    <TableCell colSpan={6} sx={{ py: 0 }}>
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
            />
            <FormControl fullWidth>
              <InputLabel>Transport Type</InputLabel>
              <Select
                value={formData.transport}
                label="Transport Type"
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    transport: e.target.value as McpServer["transport"],
                  })
                }
              >
                <MenuItem value="streamable-http">Streamable HTTP</MenuItem>
                <MenuItem value="sse">SSE (Server-Sent Events)</MenuItem>
                <MenuItem value="stdio">Stdio (Local Process)</MenuItem>
              </Select>
            </FormControl>
            {(formData.transport === "streamable-http" || formData.transport === "sse") && (
              <TextField
                label="URL"
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                fullWidth
                required
                placeholder="http://localhost:4000/mcp"
                helperText="Supports ${BACKEND_URL} environment variable"
              />
            )}
            {formData.transport === "stdio" && (
              <TextField
                label="Command"
                value={formData.command}
                onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                fullWidth
                required
                placeholder="npx -y @modelcontextprotocol/server-example"
              />
            )}
            <TextField
              label="Access Token (optional)"
              value={formData.accessToken}
              onChange={(e) => setFormData({ ...formData, accessToken: e.target.value })}
              fullWidth
              placeholder="${MCP_ACCESS_TOKEN}"
              helperText="Supports ${ENV_VAR} syntax"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={formData.isInternal || false}
                  onChange={(e) => setFormData({ ...formData, isInternal: e.target.checked })}
                />
              }
              label="Internal Server (injects userId, sessionId, etc.)"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleAddServer}
            variant="contained"
            disabled={formLoading || !formData.name}
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
            />
            <FormControl fullWidth>
              <InputLabel>Transport Type</InputLabel>
              <Select
                value={formData.transport}
                label="Transport Type"
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    transport: e.target.value as McpServer["transport"],
                  })
                }
              >
                <MenuItem value="streamable-http">Streamable HTTP</MenuItem>
                <MenuItem value="sse">SSE (Server-Sent Events)</MenuItem>
                <MenuItem value="stdio">Stdio (Local Process)</MenuItem>
              </Select>
            </FormControl>
            {(formData.transport === "streamable-http" || formData.transport === "sse") && (
              <TextField
                label="URL"
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                fullWidth
                required
              />
            )}
            {formData.transport === "stdio" && (
              <TextField
                label="Command"
                value={formData.command}
                onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                fullWidth
                required
              />
            )}
            <TextField
              label="Access Token (optional)"
              value={formData.accessToken}
              onChange={(e) => setFormData({ ...formData, accessToken: e.target.value })}
              fullWidth
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={formData.isInternal || false}
                  onChange={(e) => setFormData({ ...formData, isInternal: e.target.checked })}
                />
              }
              label="Internal Server"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleEditServer}
            variant="contained"
            disabled={formLoading}
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

export default McpServersTab;
