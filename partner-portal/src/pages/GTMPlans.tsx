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
  CircularProgress,
  Alert,
  Chip,
  TextField,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Tooltip,
} from "@mui/material";
import {
  ExpandMore as ExpandMoreIcon,
  Edit as EditIcon,
  Person as PersonIcon,
  CheckCircle as CheckCircleIcon,
} from "@mui/icons-material";
import { format } from "date-fns";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";

interface WorkItem {
  id: string;
  title: string;
  description?: string;
  duration?: number;
  dri?: string;
  status: "pending" | "completed" | "skipped";
  notes?: string;
}

interface Phase {
  id: string;
  title: string;
  description?: string;
  duration?: number;
  dri?: string;
  status: "in_progress" | "completed";
  workItems: WorkItem[];
}

interface GTMPlan {
  planId: string;
  userId: string;
  title: string;
  description?: string;
  dri?: string;
  status: "in_progress" | "completed";
  phases: Phase[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  userEmail?: string;
  userName?: string;
}

export default function GTMPlans() {
  const { token } = useAuth();
  const [plans, setPlans] = useState<GTMPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<{
    planId: string;
    phaseId: string;
    workItemId: string;
    field: "status" | "notes" | "dri";
    value: any;
  } | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPlans();
  }, []);

  const fetchPlans = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await axios.get(buildApiUrl("/api/admin/gtm-plans"), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.data.success) {
        setPlans(response.data.data || []);
      } else {
        setError("Failed to fetch GTM plans");
      }
    } catch (err: any) {
      console.error("Error fetching GTM plans:", err);
      setError(err.response?.data?.error || "Failed to fetch GTM plans");
    } finally {
      setLoading(false);
    }
  };

  const handleEditClick = (
    planId: string,
    phaseId: string,
    workItemId: string,
    field: "status" | "notes" | "dri",
    currentValue: any
  ) => {
    setEditingItem({ planId, phaseId, workItemId, field, value: currentValue });
    setEditValue(currentValue || "");
    setEditDialogOpen(true);
  };

  const handleSave = async () => {
    if (!editingItem) return;

    try {
      setSaving(true);
      setError(null);
      const updateData: any = {};
      updateData[editingItem.field] = editingItem.field === "status" ? editValue : editValue || null;

      const response = await axios.put(
        buildApiUrl(
          `/api/admin/gtm-plans/${editingItem.planId}/phases/${editingItem.phaseId}/work-items/${editingItem.workItemId}`
        ),
        updateData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      // Update only the impacted plan in state
      if (response.data.success && response.data.data) {
        const updatedPlan = response.data.data;
        
        // Preserve user info from existing plan and merge with updated data
        setPlans((prevPlans) =>
          prevPlans.map((plan) => {
            if (plan.planId === editingItem.planId) {
              return {
                ...updatedPlan,
                userEmail: plan.userEmail,
                userName: plan.userName,
              };
            }
            return plan;
          })
        );
      } else {
        // Fallback: reload all plans if response doesn't have the data
        await fetchPlans();
      }

      setEditDialogOpen(false);
      setEditingItem(null);
      setEditValue("");
    } catch (err: any) {
      console.error("Error updating work item:", err);
      setError(err.response?.data?.error || "Failed to update work item");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditDialogOpen(false);
    setEditingItem(null);
    setEditValue("");
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "success";
      case "in_progress":
        return "info";
      case "pending":
        return "warning";
      case "skipped":
        return "default";
      default:
        return "default";
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h4" component="h1" gutterBottom>
        GTM Plans
      </Typography>
      <Typography variant="body1" color="text.secondary" paragraph>
        Manage GTM Plans from all users. Update status, notes, and assign PoC for plan items.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {plans.length === 0 ? (
        <Paper sx={{ p: 3, textAlign: "center" }}>
          <Typography variant="body1" color="text.secondary">
            No GTM plans found.
          </Typography>
        </Paper>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {plans.map((plan) => (
            <Paper key={plan.planId} sx={{ p: 2 }}>
              <Box sx={{ mb: 2 }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", mb: 1 }}>
                  <Box>
                    <Typography variant="h6" component="h2">
                      {plan.title}
                    </Typography>
                    {plan.description && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {plan.description}
                      </Typography>
                    )}
                    <Box sx={{ display: "flex", gap: 1, mt: 1, flexWrap: "wrap" }}>
                      <Chip label={plan.status} color={getStatusColor(plan.status) as any} size="small" />
                      {plan.userName && (
                        <Chip
                          label={`Owner: ${plan.userName}`}
                          size="small"
                          variant="outlined"
                        />
                      )}
                      {plan.userEmail && (
                        <Chip
                          label={plan.userEmail}
                          size="small"
                          variant="outlined"
                        />
                      )}
                      {plan.dri && (
                        <Chip
                          icon={<PersonIcon />}
                          label={`PoC: ${plan.dri}`}
                          size="small"
                          variant="outlined"
                        />
                      )}
                      <Chip
                        label={`Created: ${format(new Date(plan.createdAt), "MMM d, yyyy")}`}
                        size="small"
                        variant="outlined"
                      />
                      {plan.completedAt && (
                        <Chip
                          label={`Completed: ${format(new Date(plan.completedAt), "MMM d, yyyy")}`}
                          size="small"
                          variant="outlined"
                          color="success"
                        />
                      )}
                    </Box>
                  </Box>
                </Box>
              </Box>

              {plan.phases && plan.phases.length > 0 ? (
                <Box>
                  {plan.phases.map((phase) => (
                    <Accordion key={phase.id} defaultExpanded={phase.status === "in_progress"}>
                      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%", mr: 2 }}>
                          <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
                            {phase.title}
                          </Typography>
                          <Chip
                            label={phase.status}
                            color={getStatusColor(phase.status) as any}
                            size="small"
                          />
                          {phase.dri && (
                            <Chip
                              icon={<PersonIcon />}
                              label={phase.dri}
                              size="small"
                              variant="outlined"
                            />
                          )}
                        </Box>
                      </AccordionSummary>
                      <AccordionDetails>
                        {phase.description && (
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                            {phase.description}
                          </Typography>
                        )}
                        {phase.workItems && phase.workItems.length > 0 ? (
                          <TableContainer>
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell>Title</TableCell>
                                  <TableCell>Status</TableCell>
                                  <TableCell>PoC</TableCell>
                                  <TableCell>Notes</TableCell>
                                  <TableCell align="right">Actions</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {phase.workItems.map((item) => (
                                  <TableRow key={item.id}>
                                    <TableCell>
                                      <Typography variant="body2" fontWeight="medium">
                                        {item.title}
                                      </Typography>
                                      {item.description && (
                                        <Typography variant="caption" color="text.secondary" display="block">
                                          {item.description}
                                        </Typography>
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      <Chip
                                        label={item.status}
                                        color={getStatusColor(item.status) as any}
                                        size="small"
                                      />
                                    </TableCell>
                                    <TableCell>
                                      {item.dri ? (
                                        <Chip
                                          icon={<PersonIcon />}
                                          label={item.dri}
                                          size="small"
                                          variant="outlined"
                                        />
                                      ) : (
                                        <Typography variant="body2" color="text.secondary">
                                          -
                                        </Typography>
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {item.notes ? (
                                        <Typography variant="body2" sx={{ maxWidth: 300 }}>
                                          {item.notes}
                                        </Typography>
                                      ) : (
                                        <Typography variant="body2" color="text.secondary">
                                          -
                                        </Typography>
                                      )}
                                    </TableCell>
                                    <TableCell align="right">
                                      <Box sx={{ display: "flex", gap: 0.5, justifyContent: "flex-end" }}>
                                        <Tooltip title="Edit Status">
                                          <IconButton
                                            size="small"
                                            onClick={() =>
                                              handleEditClick(plan.planId, phase.id, item.id, "status", item.status)
                                            }
                                          >
                                            <CheckCircleIcon fontSize="small" />
                                          </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Edit Notes">
                                          <IconButton
                                            size="small"
                                            onClick={() =>
                                              handleEditClick(plan.planId, phase.id, item.id, "notes", item.notes)
                                            }
                                          >
                                            <EditIcon fontSize="small" />
                                          </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Assign PoC">
                                          <IconButton
                                            size="small"
                                            onClick={() =>
                                              handleEditClick(plan.planId, phase.id, item.id, "dri", item.dri)
                                            }
                                          >
                                            <PersonIcon fontSize="small" />
                                          </IconButton>
                                        </Tooltip>
                                      </Box>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </TableContainer>
                        ) : (
                          <Typography variant="body2" color="text.secondary">
                            No work items in this phase.
                          </Typography>
                        )}
                      </AccordionDetails>
                    </Accordion>
                  ))}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  No phases in this plan.
                </Typography>
              )}
            </Paper>
          ))}
        </Box>
      )}

      <Dialog open={editDialogOpen} onClose={handleCancel} maxWidth="sm" fullWidth>
        <DialogTitle>
          Edit {editingItem?.field === "status" ? "Status" : editingItem?.field === "notes" ? "Notes" : "PoC"}
        </DialogTitle>
        <DialogContent>
          {editingItem?.field === "status" ? (
            <FormControl fullWidth sx={{ mt: 2 }}>
              <InputLabel>Status</InputLabel>
              <Select
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                label="Status"
              >
                <MenuItem value="pending">Pending</MenuItem>
                <MenuItem value="completed">Completed</MenuItem>
                <MenuItem value="skipped">Skipped</MenuItem>
              </Select>
            </FormControl>
          ) : editingItem?.field === "notes" ? (
            <TextField
              fullWidth
              multiline
              rows={4}
              label="Notes"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              sx={{ mt: 2 }}
              placeholder="Enter notes about this work item..."
            />
          ) : (
            <TextField
              fullWidth
              label="PoC (Point of Contact) Email"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              sx={{ mt: 2 }}
              placeholder="Enter email address..."
              type="email"
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} variant="contained" disabled={saving}>
            {saving ? <CircularProgress size={20} /> : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
