import { useEffect, useState } from "react";
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
  Checkbox,
  FormGroup,
  FormControlLabel,
  Card,
  CardContent,
  CardActionArea,
  Grid,
} from "@mui/material";
import {
  ExpandMore as ExpandMoreIcon,
  Person as PersonIcon,
  CheckCircle as CheckCircleIcon,
  CalendarToday as CalendarTodayIcon,
  Warning as WarningIcon,
  Error as ErrorIcon,
  ArrowBack as ArrowBackIcon,
  Business as BusinessIcon,
  Assessment as AssessmentIcon,
} from "@mui/icons-material";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
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
  dueDate?: string;
  completedAt?: string;
}

interface Phase {
  id: string;
  title: string;
  description?: string;
  duration?: number;
  dri?: string;
  status: "in_progress" | "completed";
  workItems: WorkItem[];
  dueDate?: string;
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
  supportNote?: string;
  dueDate?: string;
}

interface UserStats {
  userId: string;
  userEmail?: string;
  userName?: string;
  supportNote?: string;
  totalPlans: number;
  incompletePlans: number;
  yellowWarningPlans: number;
  redAlertPlans: number;
  pendingAgentWebItems: Record<string, number>;
  unassignedPendingItems: number;
  plans: GTMPlan[];
}

export default function GTMPlans() {
  const { token } = useAuth();
  const [plans, setPlans] = useState<GTMPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<{
    planId: string;
    phaseId?: string;
    workItemId?: string;
    field: "status" | "notes" | "dri" | "statusAndNotes" | "dueDate";
    value: any;
    type: "plan" | "phase" | "workItem";
  } | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editDueDate, setEditDueDate] = useState<string>("");
  const [editDueDateValue, setEditDueDateValue] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [constraintDialogOpen, setConstraintDialogOpen] = useState(false);
  const [constraintMessage, setConstraintMessage] = useState("");
  const [pendingConstraintUpdate, setPendingConstraintUpdate] = useState<{
    updateFn: () => Promise<void>;
  } | null>(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [notificationOptions, setNotificationOptions] = useState<{
    notifyUser: boolean;
    notifyItemPoc: boolean;
    notifyPhasePoc: boolean;
    notifyPlanPoc: boolean;
  }>({
    notifyUser: false,
    notifyItemPoc: false,
    notifyPhasePoc: false,
    notifyPlanPoc: false,
  });
  const [notificationMessage, setNotificationMessage] = useState("");
  const [pendingUpdate, setPendingUpdate] = useState<{
    updateData: any;
    planId: string;
    phaseId: string;
    workItemId: string;
  } | null>(null);
  const [statusReportDialogOpen, setStatusReportDialogOpen] = useState(false);
  const [statusReportType, setStatusReportType] = useState<"phase" | "plan" | null>(null);
  const [statusReportTarget, setStatusReportTarget] = useState<{
    planId: string;
    phaseId?: string;
  } | null>(null);
  const [statusReportMessage, setStatusReportMessage] = useState("");
  const [statusReportOptions, setStatusReportOptions] = useState<{
    notifyUser: boolean;
    notifyPlanPoc: boolean;
    notifyPhasePocs: boolean;
    notifyPhasePoc: boolean;
  }>({
    notifyUser: false,
    notifyPlanPoc: false,
    notifyPhasePocs: false,
    notifyPhasePoc: false,
  });
  const [sendingStatusReport, setSendingStatusReport] = useState(false);

  useEffect(() => {
    fetchPlans();
    // Load notification preferences from localStorage
    const savedPrefs = localStorage.getItem("gtm-plans-notification-prefs");
    if (savedPrefs) {
      try {
        const prefs = JSON.parse(savedPrefs);
        setNotificationOptions(prefs);
      } catch (e) {
        console.error("Error loading notification preferences:", e);
      }
    }
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
    type: "plan" | "phase" | "workItem",
    field: "status" | "notes" | "dri" | "statusAndNotes" | "dueDate",
    phaseId?: string,
    workItemId?: string,
    currentValue?: any,
    currentStatus?: string,
    currentNotes?: string,
    currentDueDate?: string
  ) => {
    setEditingItem({ planId, phaseId, workItemId, field, value: currentValue, type });
    
    if (field === "statusAndNotes") {
      setEditStatus(currentStatus || "");
      setEditNotes(currentNotes || "");
      setEditValue(""); // Not used for this mode
      setEditDueDate("");
      setEditDueDateValue(null);
    } else if (field === "dueDate") {
      const dateStr = currentDueDate || "";
      setEditDueDate(dateStr);
      if (dateStr) {
        const [year, month, day] = dateStr.split('-').map(Number);
        setEditDueDateValue(new Date(year, month - 1, day));
      } else {
        setEditDueDateValue(null);
      }
      setEditValue("");
      setEditStatus("");
      setEditNotes("");
    } else {
      setEditValue(currentValue || "");
      setEditStatus("");
      setEditNotes("");
      setEditDueDate("");
      setEditDueDateValue(null);
    }
    
    setEditDialogOpen(true);
  };

  const handleSave = () => {
    if (!editingItem) return;

    // Handle plan-level updates (no notifications needed)
    if (editingItem.type === "plan") {
      if (editingItem.field === "dri") {
        performPlanUpdate(editingItem.planId, { dri: editValue || null });
      } else if (editingItem.field === "dueDate") {
        // Check constraints before saving
        if (editDueDateValue) {
          const constraintMsg = checkDateConstraints(editDueDateValue, "plan", editingItem.planId);
          if (constraintMsg) {
            setConstraintMessage(constraintMsg);
            setPendingConstraintUpdate({
              updateFn: () => performPlanUpdate(editingItem.planId, { dueDate: editDueDate || null }),
            });
            setConstraintDialogOpen(true);
            return;
          }
        }
        performPlanUpdate(editingItem.planId, { dueDate: editDueDate || null });
      }
      return;
    }

    // Handle phase-level updates (no notifications needed)
    if (editingItem.type === "phase" && editingItem.phaseId) {
      if (editingItem.field === "dri") {
        performPhaseUpdate(editingItem.planId, editingItem.phaseId, { dri: editValue || null });
      } else if (editingItem.field === "dueDate") {
        // Check constraints before saving
        if (editDueDateValue) {
          const constraintMsg = checkDateConstraints(editDueDateValue, "phase", editingItem.planId, editingItem.phaseId);
          if (constraintMsg) {
            setConstraintMessage(constraintMsg);
            setPendingConstraintUpdate({
              updateFn: () => performPhaseUpdate(editingItem.planId, editingItem.phaseId!, { dueDate: editDueDate || null }),
            });
            setConstraintDialogOpen(true);
            return;
          }
        }
        performPhaseUpdate(editingItem.planId, editingItem.phaseId, { dueDate: editDueDate || null });
      }
      return;
    }

    // Handle work item updates (existing logic with notifications)
    const updateData: any = {};
    
    if (editingItem.field === "statusAndNotes") {
      // Handle both status and notes together
      updateData.status = editStatus;
      updateData.notes = editNotes || null;
    } else if (editingItem.field === "dueDate") {
      // Check constraints before saving
      if (editDueDateValue) {
        const constraintMsg = checkDateConstraints(
          editDueDateValue,
          "workItem",
          editingItem.planId,
          editingItem.phaseId
        );
        if (constraintMsg) {
          setConstraintMessage(constraintMsg);
          setPendingConstraintUpdate({
            updateFn: async () => {
              // After constraint confirmation, proceed with normal update flow
              const updateData: any = { dueDate: editDueDate || null };
              // Find the plan, phase, and work item to get PoCs
              const plan = plans.find((p) => p.planId === editingItem.planId);
              if (!plan) return;
              const phase = plan.phases?.find((p) => p.id === editingItem.phaseId);
              if (!phase) return;
              const workItem = phase.workItems?.find((item) => item.id === editingItem.workItemId);
              if (!workItem) return;
              
              // Check if there are any PoCs or user to notify
              const itemPoc = workItem.dri;
              const phasePoc = phase.dri;
              const planPoc = plan.dri;
              const hasPocs = !!(itemPoc || phasePoc || planPoc);
              const hasUser = !!(plan.userEmail);
              
              // If there's nothing to notify, proceed directly
              if (!hasPocs && !hasUser) {
                await performUpdate(updateData, editingItem.planId, editingItem.phaseId!, editingItem.workItemId!);
              } else {
                // Store pending update and show confirmation dialog
                setPendingUpdate({
                  updateData,
                  planId: editingItem.planId,
                  phaseId: editingItem.phaseId!,
                  workItemId: editingItem.workItemId!,
                });
                setConfirmDialogOpen(true);
              }
            },
          });
          setConstraintDialogOpen(true);
          return;
        }
      }
      // No constraint violation, proceed with normal update flow
      updateData.dueDate = editDueDate || null;
    } else {
      // Handle single field updates
      updateData[editingItem.field] = editingItem.field === "status" ? editValue : editValue || null;
    }

    // Find the plan, phase, and work item to get PoCs
    const plan = plans.find((p) => p.planId === editingItem.planId);
    if (!plan) return;

    const phase = plan.phases?.find((p) => p.id === editingItem.phaseId);
    if (!phase) return;

    const workItem = phase.workItems?.find((item) => item.id === editingItem.workItemId);
    if (!workItem) return;

    // Collect all PoCs
    const itemPoc = workItem.dri;
    const phasePoc = phase.dri;
    const planPoc = plan.dri;

    // Check if there are any PoCs or user to notify
    const hasPocs = !!(itemPoc || phasePoc || planPoc);
    const hasUser = !!(plan.userEmail);

    // If there's nothing to notify, proceed directly
    if (!hasPocs && !hasUser) {
      performUpdate(updateData, editingItem.planId, editingItem.phaseId!, editingItem.workItemId!);
      return;
    }

    // Store pending update and show confirmation dialog
    setPendingUpdate({
      updateData,
      planId: editingItem.planId,
      phaseId: editingItem.phaseId!,
      workItemId: editingItem.workItemId!,
    });
    setConfirmDialogOpen(true);
  };

  const performPlanUpdate = async (
    planId: string,
    updateData: { dri?: string | null; dueDate?: string | null }
  ) => {
    try {
      setSaving(true);
      setError(null);

      const response = await axios.put(
        buildApiUrl(`/api/admin/gtm-plans/${planId}`),
        updateData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.data.success && response.data.data) {
        const updatedPlan = response.data.data;
        setPlans((prevPlans) =>
          prevPlans.map((plan) => {
            if (plan.planId === planId) {
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
        await fetchPlans(); // Fallback
      }

      setEditDialogOpen(false);
      setEditingItem(null);
      setEditValue("");
      setEditDueDate("");
      setEditDueDateValue(null);
    } catch (err: any) {
      console.error("Error updating plan:", err);
      setError(err.response?.data?.error || "Failed to update plan");
    } finally {
      setSaving(false);
    }
  };

  const performPhaseUpdate = async (
    planId: string,
    phaseId: string,
    updateData: { dri?: string | null; dueDate?: string | null }
  ) => {
    try {
      setSaving(true);
      setError(null);

      const response = await axios.put(
        buildApiUrl(`/api/admin/gtm-plans/${planId}/phases/${phaseId}`),
        updateData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.data.success && response.data.data) {
        const updatedPlan = response.data.data;
        setPlans((prevPlans) =>
          prevPlans.map((plan) => {
            if (plan.planId === planId) {
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
        await fetchPlans(); // Fallback
      }

      setEditDialogOpen(false);
      setEditingItem(null);
      setEditValue("");
      setEditDueDate("");
      setEditDueDateValue(null);
    } catch (err: any) {
      console.error("Error updating phase:", err);
      setError(err.response?.data?.error || "Failed to update phase");
    } finally {
      setSaving(false);
    }
  };

  const performUpdate = async (
    updateData: any,
    planId: string,
    phaseId: string,
    workItemId: string
  ) => {
    try {
      setSaving(true);
      setError(null);

      // Add notification preferences and message to update data
      const updatePayload = {
        ...updateData,
        notifications: {
          ...notificationOptions,
          message: notificationMessage.trim() || undefined,
        },
      };

      const response = await axios.put(
        buildApiUrl(
          `/api/admin/gtm-plans/${planId}/phases/${phaseId}/work-items/${workItemId}`
        ),
        updatePayload,
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
            if (plan.planId === planId) {
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
      setConfirmDialogOpen(false);
      setEditingItem(null);
      setEditValue("");
      setEditStatus("");
      setEditNotes("");
      setEditDueDate("");
      setEditDueDateValue(null);
      setNotificationMessage("");
      setPendingUpdate(null);
    } catch (err: any) {
      console.error("Error updating work item:", err);
      setError(err.response?.data?.error || "Failed to update work item");
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmSave = () => {
    // Save notification preferences to localStorage
    localStorage.setItem("gtm-plans-notification-prefs", JSON.stringify(notificationOptions));

    if (pendingUpdate) {
      performUpdate(
        pendingUpdate.updateData,
        pendingUpdate.planId,
        pendingUpdate.phaseId,
        pendingUpdate.workItemId
      );
    }
  };

  const handleCancelConfirm = () => {
    setConfirmDialogOpen(false);
    setPendingUpdate(null);
    setNotificationMessage("");
  };

  const handleConstraintConfirm = async () => {
    if (pendingConstraintUpdate) {
      await pendingConstraintUpdate.updateFn();
    }
    setConstraintDialogOpen(false);
    setPendingConstraintUpdate(null);
    setConstraintMessage("");
  };

  const handleConstraintCancel = () => {
    setConstraintDialogOpen(false);
    setPendingConstraintUpdate(null);
    setConstraintMessage("");
    // Reset the edit dialog state
    setEditDialogOpen(false);
    setEditingItem(null);
    setEditValue("");
    setEditDueDate("");
    setEditDueDateValue(null);
  };

  const handleCancel = () => {
    setEditDialogOpen(false);
    setEditingItem(null);
    setEditValue("");
    setEditStatus("");
    setEditNotes("");
    setEditDueDate("");
  };

  // Status Report Handlers
  const handleOpenStatusReport = (type: "phase" | "plan", planId: string, phaseId?: string) => {
    setStatusReportType(type);
    setStatusReportTarget({ planId, phaseId });
    setStatusReportMessage("");

    // Load preferences from localStorage
    const storageKey = type === "phase"
      ? "gtm-plans-phase-status-report-prefs"
      : "gtm-plans-plan-status-report-prefs";
    const savedPrefs = localStorage.getItem(storageKey);

    if (savedPrefs) {
      try {
        const prefs = JSON.parse(savedPrefs);
        setStatusReportOptions(prefs);
      } catch (e) {
        // Use defaults if parsing fails
        setStatusReportOptions({
          notifyUser: false,
          notifyPlanPoc: false,
          notifyPhasePocs: false,
          notifyPhasePoc: false,
        });
      }
    } else {
      // Default all to true for first-time users
      setStatusReportOptions({
        notifyUser: true,
        notifyPlanPoc: true,
        notifyPhasePocs: type === "plan",
        notifyPhasePoc: type === "phase",
      });
    }

    setStatusReportDialogOpen(true);
  };

  const handleCancelStatusReport = () => {
    setStatusReportDialogOpen(false);
    setStatusReportType(null);
    setStatusReportTarget(null);
    setStatusReportMessage("");
  };

  const handleSendStatusReport = async () => {
    if (!statusReportTarget) return;

    setSendingStatusReport(true);

    try {
      // Save preferences to localStorage
      const storageKey = statusReportType === "phase"
        ? "gtm-plans-phase-status-report-prefs"
        : "gtm-plans-plan-status-report-prefs";
      localStorage.setItem(storageKey, JSON.stringify(statusReportOptions));

      const endpoint = statusReportType === "phase"
        ? `/api/admin/gtm-plans/${statusReportTarget.planId}/phases/${statusReportTarget.phaseId}/send-status-report`
        : `/api/admin/gtm-plans/${statusReportTarget.planId}/send-status-report`;

      const response = await axios.post(
        buildApiUrl(endpoint),
        {
          notifications: statusReportOptions,
          message: statusReportMessage || undefined,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.data.success) {
        handleCancelStatusReport();
      } else {
        throw new Error(response.data.error || "Failed to send status report");
      }
    } catch (err: any) {
      console.error("Error sending status report:", err);
    } finally {
      setSendingStatusReport(false);
    }
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

  const getDueDateStatus = (
    dueDate?: string,
    itemStatus?: string,
    itemType?: "plan" | "phase" | "workItem"
  ): "overdue" | "warning" | "ok" | null => {
    if (!dueDate) return null;
    
    // Only show color difference based on status
    // If status or type is not provided, don't show colors (safety check)
    if (!itemStatus || !itemType) {
      return null;
    }
    
    // Only show warning/overdue colors for active items
    if (itemType === "workItem") {
      if (itemStatus !== "pending") {
        return null; // Don't show warning/overdue for completed or skipped items
      }
    } else if (itemType === "plan" || itemType === "phase") {
      if (itemStatus !== "in_progress") {
        return null; // Don't show warning/overdue for completed plans/phases
      }
    }
    
    // Parse date as local date (YYYY-MM-DD format)
    const [year, month, day] = dueDate.split('-').map(Number);
    const due = new Date(year, month - 1, day);
    due.setHours(0, 0, 0, 0);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const diffTime = due.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) {
      return "overdue"; // Past due - red
    } else if (diffDays === 0) {
      return "overdue"; // Due today - red
    } else if (diffDays <= 3) {
      return "warning"; // 3 days or less before due - yellow
    }
    
    return "ok"; // More than 3 days away - no warning
  };

  const checkDateConstraints = (
    date: Date,
    type: "plan" | "phase" | "workItem",
    planId: string,
    phaseId?: string
  ): string | null => {
    const plan = plans.find((p) => p.planId === planId);
    if (!plan) return null;

    let warningMessage = "";

    if (type === "workItem") {
      // Work item due date should not be after phase due date
      const phase = plan.phases?.find((p) => p.id === phaseId);
      if (phase?.dueDate) {
        const [year, month, day] = phase.dueDate.split('-').map(Number);
        const phaseDueDate = new Date(year, month - 1, day);
        phaseDueDate.setHours(23, 59, 59, 999);
        if (date > phaseDueDate) {
          warningMessage = `Warning: Work item due date (${format(date, "MMM d, yyyy")}) is after phase due date (${format(phaseDueDate, "MMM d, yyyy")})`;
        }
      }
      // Also check plan due date if phase doesn't have one
      if (!warningMessage && plan.dueDate) {
        const [year, month, day] = plan.dueDate.split('-').map(Number);
        const planDueDate = new Date(year, month - 1, day);
        planDueDate.setHours(23, 59, 59, 999);
        if (date > planDueDate) {
          warningMessage = `Warning: Work item due date (${format(date, "MMM d, yyyy")}) is after plan due date (${format(planDueDate, "MMM d, yyyy")})`;
        }
      }
    } else if (type === "phase") {
      // Phase due date should not be after plan due date
      if (plan.dueDate) {
        const [year, month, day] = plan.dueDate.split('-').map(Number);
        const planDueDate = new Date(year, month - 1, day);
        planDueDate.setHours(23, 59, 59, 999);
        if (date > planDueDate) {
          warningMessage = `Warning: Phase due date (${format(date, "MMM d, yyyy")}) is after plan due date (${format(planDueDate, "MMM d, yyyy")})`;
        }
      }
      // Phase due date should not be before work item due dates
      const phase = plan.phases?.find((p) => p.id === phaseId);
      if (phase?.workItems) {
        for (const item of phase.workItems) {
          if (item.dueDate) {
            const [itemYear, itemMonth, itemDay] = item.dueDate.split('-').map(Number);
            const itemDueDate = new Date(itemYear, itemMonth - 1, itemDay);
            itemDueDate.setHours(0, 0, 0, 0);
            if (date < itemDueDate) {
              warningMessage = `Warning: Phase due date (${format(date, "MMM d, yyyy")}) is before work item due date (${format(itemDueDate, "MMM d, yyyy")} for item "${item.title}")`;
              break;
            }
          }
        }
      }
    } else if (type === "plan") {
      // Plan due date should not be before phase or work item due dates
      for (const phase of plan.phases || []) {
        if (phase.dueDate) {
          const [year, month, day] = phase.dueDate.split('-').map(Number);
          const phaseDueDate = new Date(year, month - 1, day);
          phaseDueDate.setHours(0, 0, 0, 0);
          if (date < phaseDueDate) {
            warningMessage = `Warning: Plan due date (${format(date, "MMM d, yyyy")}) is before phase due date (${format(phaseDueDate, "MMM d, yyyy")} for phase "${phase.title}")`;
            break;
          }
        }
        // Check work items
        if (!warningMessage && phase.workItems) {
          for (const item of phase.workItems) {
            if (item.dueDate) {
              const [itemYear, itemMonth, itemDay] = item.dueDate.split('-').map(Number);
              const itemDueDate = new Date(itemYear, itemMonth - 1, itemDay);
              itemDueDate.setHours(0, 0, 0, 0);
              if (date < itemDueDate) {
                warningMessage = `Warning: Plan due date (${format(date, "MMM d, yyyy")}) is before work item due date (${format(itemDueDate, "MMM d, yyyy")} for item "${item.title}" in phase "${phase.title}")`;
                break;
              }
            }
          }
        }
        if (warningMessage) break;
      }
    }

    return warningMessage || null;
  };

  const getDueDateIcon = (
    dueDate?: string,
    itemStatus?: string,
    itemType?: "plan" | "phase" | "workItem"
  ) => {
    const status = getDueDateStatus(dueDate, itemStatus, itemType);
    if (status === "overdue") {
      return <ErrorIcon fontSize="small" sx={{ color: "error.main" }} />;
    } else if (status === "warning") {
      return <WarningIcon fontSize="small" sx={{ color: "warning.main" }} />;
    } else if (dueDate) {
      return <CalendarTodayIcon fontSize="small" />;
    }
    return undefined;
  };

  const groupPlansByUser = (): UserStats[] => {
    const userMap = new Map<string, UserStats>();

    plans.forEach((plan) => {
      if (!userMap.has(plan.userId)) {
        userMap.set(plan.userId, {
          userId: plan.userId,
          userEmail: plan.userEmail,
          userName: plan.userName,
          supportNote: plan.supportNote,
          totalPlans: 0,
          incompletePlans: 0,
          yellowWarningPlans: 0,
          redAlertPlans: 0,
          pendingAgentWebItems: {},
          unassignedPendingItems: 0,
          plans: [],
        });
      }

      const userStats = userMap.get(plan.userId)!;
      userStats.plans.push(plan);
      userStats.totalPlans++;

      // Aggregate pending @agentweb.pro and unassigned work items
      plan.phases?.forEach((phase) => {
        phase.workItems?.forEach((workItem) => {
          if (workItem.status === "pending") {
            if (workItem.dri?.toLowerCase().endsWith("@agentweb.pro")) {
              const email = workItem.dri.toLowerCase();
              userStats.pendingAgentWebItems[email] =
                (userStats.pendingAgentWebItems[email] || 0) + 1;
            } else if (!workItem.dri || workItem.dri.trim() === "") {
              userStats.unassignedPendingItems++;
            }
          }
        });
      });

      if (plan.status === "in_progress") {
        userStats.incompletePlans++;

        const dueDateStatus = getDueDateStatus(plan.dueDate, plan.status, "plan");
        if (dueDateStatus === "overdue") {
          userStats.redAlertPlans++;
        } else if (dueDateStatus === "warning") {
          userStats.yellowWarningPlans++;
        }
      }
    });

    return Array.from(userMap.values()).filter((stats) => stats.totalPlans > 0);
  };

  const userStatsList = groupPlansByUser();
  const selectedUserStats = selectedUserId
    ? userStatsList.find((stats) => stats.userId === selectedUserId)
    : null;

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
        GTM Tracker
      </Typography>
      <Typography variant="body1" color="text.secondary" paragraph>
        Track GTM plans from all users. Update status, notes, and assign PoC for plan items.
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
      ) : !selectedUserId ? (
        // Level 1: User Cards View
        <Box>
          <Grid container spacing={3}>
            {userStatsList.map((userStats) => (
              <Grid item xs={12} sm={6} md={4} key={userStats.userId}>
                <Card sx={{ height: "100%" }}>
                  <CardActionArea onClick={() => setSelectedUserId(userStats.userId)}>
                    <CardContent>
                      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
                        <BusinessIcon sx={{ mr: 1, color: "primary.main" }} />
                        <Typography variant="h6" component="div">
                          {userStats.supportNote || userStats.userName || "Unknown User"}
                        </Typography>
                      </Box>

                      {userStats.userEmail && (
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                          {userStats.userEmail}
                        </Typography>
                      )}

                      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <Typography variant="body2" color="text.secondary">
                            Total Plans:
                          </Typography>
                          <Chip label={userStats.totalPlans} size="small" color="default" />
                        </Box>

                        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <Typography variant="body2" color="text.secondary">
                            In Progress:
                          </Typography>
                          <Chip label={userStats.incompletePlans} size="small" color="info" />
                        </Box>

                        {userStats.yellowWarningPlans > 0 && (
                          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Typography variant="body2" color="text.secondary">
                              Due in 3 Days:
                            </Typography>
                            <Chip
                              label={userStats.yellowWarningPlans}
                              size="small"
                              color="warning"
                              icon={<WarningIcon />}
                            />
                          </Box>
                        )}

                        {userStats.redAlertPlans > 0 && (
                          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Typography variant="body2" color="text.secondary">
                              Overdue/Due Today:
                            </Typography>
                            <Chip
                              label={userStats.redAlertPlans}
                              size="small"
                              color="error"
                              icon={<ErrorIcon />}
                            />
                          </Box>
                        )}

                        {(Object.keys(userStats.pendingAgentWebItems).length > 0 || userStats.unassignedPendingItems > 0) && (
                          <Box sx={{ borderTop: 1, borderColor: "divider", pt: 1, mt: 1 }}>
                            {Object.keys(userStats.pendingAgentWebItems).length > 0 && (
                              <>
                                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.5 }}>
                                  <Typography variant="body2" color="text.secondary">
                                    Our Pending Items:
                                  </Typography>
                                  <Chip
                                    label={Object.values(userStats.pendingAgentWebItems).reduce((a, b) => a + b, 0)}
                                    size="small"
                                    color="primary"
                                    icon={<PersonIcon />}
                                  />
                                </Box>
                                {Object.entries(userStats.pendingAgentWebItems).map(([email, count]) => (
                                  <Box key={email} sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", pl: 1 }}>
                                    <Typography variant="caption" color="text.secondary">
                                      {email}
                                    </Typography>
                                    <Chip label={count} size="small" variant="outlined" />
                                  </Box>
                                ))}
                              </>
                            )}
                            {userStats.unassignedPendingItems > 0 && (
                              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mt: 0.5 }}>
                                <Typography variant="body2" color="text.secondary">
                                  Unassigned Pending:
                                </Typography>
                                <Chip
                                  label={userStats.unassignedPendingItems}
                                  size="small"
                                  color="warning"
                                  icon={<WarningIcon />}
                                />
                              </Box>
                            )}
                          </Box>
                        )}
                      </Box>
                    </CardContent>
                  </CardActionArea>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>
      ) : (
        // Level 2: Plans for Selected User
        <Box>
          <Box sx={{ mb: 3, display: "flex", alignItems: "center", gap: 2 }}>
            <Button
              startIcon={<ArrowBackIcon />}
              onClick={() => setSelectedUserId(null)}
              variant="outlined"
            >
              Back to Users
            </Button>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h5" component="div">
                {selectedUserStats?.supportNote || selectedUserStats?.userName || "User Plans"}
              </Typography>
              {selectedUserStats?.userEmail && (
                <Typography variant="body2" color="text.secondary">
                  {selectedUserStats.userEmail}
                </Typography>
              )}
            </Box>
          </Box>

          <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {selectedUserStats?.plans.map((plan) => (
            <Paper key={plan.planId} sx={{ p: 2 }}>
              <Box sx={{ mb: 2 }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", mb: 1 }}>
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="h6" component="h2">
                      {plan.title}
                    </Typography>
                    {plan.description && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {plan.description}
                      </Typography>
                    )}
                    <Box sx={{ display: "flex", gap: 1, mt: 1, flexWrap: "wrap", alignItems: "center" }}>
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
                      {plan.dueDate && (() => {
                        const [year, month, day] = plan.dueDate.split('-').map(Number);
                        const dueDateLocal = new Date(year, month - 1, day);
                        const dueDateStatus = getDueDateStatus(plan.dueDate, plan.status, "plan");
                        return (
                          <Chip
                            icon={getDueDateIcon(plan.dueDate, plan.status, "plan")}
                            label={format(dueDateLocal, "MMM d, yyyy")}
                            size="small"
                            variant="outlined"
                            color={
                              dueDateStatus === "overdue"
                                ? "error"
                                : dueDateStatus === "warning"
                                ? "warning"
                                : "default"
                            }
                          />
                        );
                      })()}
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
                  <Box sx={{ display: "flex", gap: 0.5, ml: 2 }}>
                    <Tooltip title="Assign Plan PoC">
                      <IconButton
                        size="small"
                        onClick={() =>
                          handleEditClick(plan.planId, "plan", "dri", undefined, undefined, plan.dri)
                        }
                      >
                        <PersonIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Set Plan Due Date">
                      <IconButton
                        size="small"
                        onClick={() =>
                          handleEditClick(plan.planId, "plan", "dueDate", undefined, undefined, undefined, undefined, undefined, plan.dueDate)
                        }
                      >
                        <CalendarTodayIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Send Plan Status Report">
                      <IconButton
                        size="small"
                        onClick={() => handleOpenStatusReport("plan", plan.planId)}
                      >
                        <AssessmentIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
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
                          {phase.dueDate && (() => {
                            const [year, month, day] = phase.dueDate.split('-').map(Number);
                            const dueDateLocal = new Date(year, month - 1, day);
                            const dueDateStatus = getDueDateStatus(phase.dueDate, phase.status, "phase");
                            const dueDateIcon = getDueDateIcon(phase.dueDate, phase.status, "phase");
                            return (
                              <Chip
                                {...(dueDateIcon && { icon: dueDateIcon })}
                                label={format(dueDateLocal, "MMM d, yyyy")}
                                size="small"
                                variant="outlined"
                                color={
                                  dueDateStatus === "overdue"
                                    ? "error"
                                    : dueDateStatus === "warning"
                                    ? "warning"
                                    : "default"
                                }
                              />
                            );
                          })()}
                          <Box
                            component="div"
                            sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <Tooltip title="Assign Phase PoC">
                              <span>
                                <IconButton
                                  size="small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleEditClick(plan.planId, "phase", "dri", phase.id, undefined, phase.dri);
                                  }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                >
                                  <PersonIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title="Set Phase Due Date">
                              <span>
                                <IconButton
                                  size="small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleEditClick(plan.planId, "phase", "dueDate", phase.id, undefined, undefined, undefined, undefined, phase.dueDate);
                                  }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                >
                                  <CalendarTodayIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title="Send Phase Status Report">
                              <span>
                                <IconButton
                                  size="small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenStatusReport("phase", plan.planId, phase.id);
                                  }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                >
                                  <AssessmentIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          </Box>
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
                                  <TableCell>Due Date</TableCell>
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
                                      {item.completedAt && (
                                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                                          {format(new Date(item.completedAt), "MMM d, yyyy")}
                                        </Typography>
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {item.dueDate ? (() => {
                                        const [year, month, day] = item.dueDate.split('-').map(Number);
                                        const dueDateLocal = new Date(year, month - 1, day);
                                        const dueDateStatus = getDueDateStatus(item.dueDate, item.status, "workItem");
                                        const dueDateIcon = getDueDateIcon(item.dueDate, item.status, "workItem");
                                        return (
                                          <Chip
                                            {...(dueDateIcon && { icon: dueDateIcon })}
                                            label={format(dueDateLocal, "MMM d, yyyy")}
                                            size="small"
                                            variant="outlined"
                                            color={
                                              dueDateStatus === "overdue"
                                                ? "error"
                                                : dueDateStatus === "warning"
                                                ? "warning"
                                                : "default"
                                            }
                                          />
                                        );
                                      })() : (
                                        <Typography variant="body2" color="text.secondary">
                                          -
                                        </Typography>
                                      )}
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
                                        <Tooltip title="Edit Status & Notes">
                                          <IconButton
                                            size="small"
                                            onClick={() =>
                                              handleEditClick(plan.planId, "workItem", "statusAndNotes", phase.id, item.id, undefined, item.status, item.notes)
                                            }
                                          >
                                            <CheckCircleIcon fontSize="small" />
                                          </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Assign PoC">
                                          <IconButton
                                            size="small"
                                            onClick={() =>
                                              handleEditClick(plan.planId, "workItem", "dri", phase.id, item.id, item.dri)
                                            }
                                          >
                                            <PersonIcon fontSize="small" />
                                          </IconButton>
                                        </Tooltip>
                                        <Tooltip title="Set Due Date">
                                          <IconButton
                                            size="small"
                                            onClick={() =>
                                              handleEditClick(plan.planId, "workItem", "dueDate", phase.id, item.id, undefined, undefined, undefined, item.dueDate)
                                            }
                                          >
                                            <CalendarTodayIcon fontSize="small" />
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
        </Box>
      )}

      <Dialog open={editDialogOpen} onClose={handleCancel} maxWidth="sm" fullWidth>
        <DialogTitle>
          {editingItem?.type === "plan"
            ? "Assign Plan PoC"
            : editingItem?.type === "phase"
            ? "Assign Phase PoC"
            : editingItem?.field === "statusAndNotes" 
            ? "Edit Status & Notes" 
            : editingItem?.field === "dri" 
            ? "Assign PoC" 
            : `Edit ${editingItem?.field === "status" ? "Status" : "Notes"}`}
        </DialogTitle>
        <DialogContent>
          {editingItem?.field === "statusAndNotes" ? (
            <Box sx={{ mt: 2 }}>
              <FormControl fullWidth sx={{ mb: 2 }}>
                <InputLabel>Status</InputLabel>
                <Select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  label="Status"
                >
                  <MenuItem value="pending">Pending</MenuItem>
                  <MenuItem value="completed">Completed</MenuItem>
                  <MenuItem value="skipped">Skipped</MenuItem>
                </Select>
              </FormControl>
              <TextField
                fullWidth
                multiline
                rows={4}
                label="Notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Enter notes about this work item..."
              />
            </Box>
          ) : editingItem?.field === "status" ? (
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
          ) : editingItem?.field === "dueDate" ? (
            <Box sx={{ mt: 2 }}>
              <DatePicker
                label={
                  editingItem?.type === "plan"
                    ? "Plan Due Date"
                    : editingItem?.type === "phase"
                    ? "Phase Due Date"
                    : "Work Item Due Date"
                }
                value={editDueDateValue}
                onChange={(newValue) => {
                  if (newValue) {
                    const year = newValue.getFullYear();
                    const month = String(newValue.getMonth() + 1).padStart(2, '0');
                    const day = String(newValue.getDate()).padStart(2, '0');
                    const dateStr = `${year}-${month}-${day}`;
                    setEditDueDate(dateStr);
                    setEditDueDateValue(newValue);
                    // Don't show warning on date selection - will show after save
                  } else {
                    setEditDueDate("");
                    setEditDueDateValue(null);
                  }
                }}
                slotProps={{
                  textField: {
                    fullWidth: true,
                    helperText: "Click the calendar icon to pick a date. Leave empty to remove the due date.",
                  },
                }}
              />
            </Box>
          ) : (
            <TextField
              fullWidth
              label={
                editingItem?.type === "plan"
                  ? "Plan PoC (Point of Contact) Email"
                  : editingItem?.type === "phase"
                  ? "Phase PoC (Point of Contact) Email"
                  : "PoC (Point of Contact) Email"
              }
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

      <Dialog open={confirmDialogOpen} onClose={handleCancelConfirm} maxWidth="sm" fullWidth>
        <DialogTitle>Confirm Update & Notification</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Select who should be notified about this update:
          </Typography>
          
          <TextField
            fullWidth
            multiline
            rows={3}
            label="Optional Message (included in notification email)"
            value={notificationMessage}
            onChange={(e) => setNotificationMessage(e.target.value)}
            placeholder="Add a personal message to include in the notification email..."
            sx={{ mb: 3 }}
            helperText="This message will be included in the notification email sent to selected recipients."
          />
          
          {pendingUpdate && (() => {
            const plan = plans.find((p) => p.planId === pendingUpdate.planId);
            const phase = plan?.phases?.find((p) => p.id === pendingUpdate.phaseId);
            const workItem = phase?.workItems?.find((item) => item.id === pendingUpdate.workItemId);
            
            const itemPoc = workItem?.dri;
            const phasePoc = phase?.dri;
            const planPoc = plan?.dri;
            const userEmail = plan?.userEmail;
            
            return (
              <FormGroup>
                {userEmail && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={notificationOptions.notifyUser}
                        onChange={(e) =>
                          setNotificationOptions((prev) => ({
                            ...prev,
                            notifyUser: e.target.checked,
                          }))
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          Notify Plan Owner
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {userEmail}
                        </Typography>
                      </Box>
                    }
                  />
                )}
                
                {planPoc && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={notificationOptions.notifyPlanPoc}
                        onChange={(e) =>
                          setNotificationOptions((prev) => ({
                            ...prev,
                            notifyPlanPoc: e.target.checked,
                          }))
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          Notify Plan PoC
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {planPoc}
                        </Typography>
                      </Box>
                    }
                  />
                )}
                
                {phasePoc && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={notificationOptions.notifyPhasePoc}
                        onChange={(e) =>
                          setNotificationOptions((prev) => ({
                            ...prev,
                            notifyPhasePoc: e.target.checked,
                          }))
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          Notify Phase PoC
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {phasePoc}
                        </Typography>
                      </Box>
                    }
                  />
                )}
                
                {itemPoc && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={notificationOptions.notifyItemPoc}
                        onChange={(e) =>
                          setNotificationOptions((prev) => ({
                            ...prev,
                            notifyItemPoc: e.target.checked,
                          }))
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          Notify Work Item PoC
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {itemPoc}
                        </Typography>
                      </Box>
                    }
                  />
                )}
                
                {!userEmail && !planPoc && !phasePoc && !itemPoc && (
                  <Typography variant="body2" color="text.secondary">
                    No recipients available to notify.
                  </Typography>
                )}
              </FormGroup>
            );
          })()}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelConfirm} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleConfirmSave} variant="contained" disabled={saving}>
            {saving ? <CircularProgress size={20} /> : "Confirm & Update"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={constraintDialogOpen} onClose={handleConstraintCancel} maxWidth="sm" fullWidth>
        <DialogTitle>Date Constraint Warning</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {constraintMessage}
          </Alert>
          <Typography variant="body2">
            This date violates the constraint that:
          </Typography>
          <Typography variant="body2" component="ul" sx={{ mt: 1, pl: 2 }}>
            <li>Work item due dates should not be after phase due dates</li>
            <li>Phase due dates should not be after plan due dates</li>
            <li>Plan due dates should not be before phase or work item due dates</li>
          </Typography>
          <Typography variant="body2" sx={{ mt: 2 }}>
            Do you want to proceed with this update anyway?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleConstraintCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleConstraintConfirm} variant="contained" color="warning" disabled={saving}>
            {saving ? <CircularProgress size={20} /> : "Proceed Anyway"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Status Report Dialog */}
      <Dialog open={statusReportDialogOpen} onClose={handleCancelStatusReport} maxWidth="sm" fullWidth>
        <DialogTitle>
          Send {statusReportType === "phase" ? "Phase" : "Plan"} Status Report
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Select who should receive this status report:
          </Typography>

          <TextField
            fullWidth
            multiline
            rows={3}
            label="Optional Message (included in status report email)"
            value={statusReportMessage}
            onChange={(e) => setStatusReportMessage(e.target.value)}
            placeholder="Add a personal message to include in the status report email..."
            sx={{ mb: 3 }}
            helperText="This message will be included at the top of the status report email."
          />

          {statusReportTarget && (() => {
            const plan = plans.find((p) => p.planId === statusReportTarget.planId);
            const phase = statusReportType === "phase" && statusReportTarget.phaseId
              ? plan?.phases?.find((p) => p.id === statusReportTarget.phaseId)
              : null;

            const userEmail = plan?.userEmail;
            const planPoc = plan?.dri;
            const phasePoc = phase?.dri;

            // For plan-level reports, get all unique phase PoCs
            const allPhasePocs = statusReportType === "plan"
              ? Array.from(new Set(
                  plan?.phases?.map(p => p.dri).filter(Boolean) || []
                ))
              : [];

            return (
              <FormGroup>
                {userEmail && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={statusReportOptions.notifyUser}
                        onChange={(e) =>
                          setStatusReportOptions((prev) => ({
                            ...prev,
                            notifyUser: e.target.checked,
                          }))
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          Notify Plan Owner
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {userEmail}
                        </Typography>
                      </Box>
                    }
                  />
                )}

                {planPoc && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={statusReportOptions.notifyPlanPoc}
                        onChange={(e) =>
                          setStatusReportOptions((prev) => ({
                            ...prev,
                            notifyPlanPoc: e.target.checked,
                          }))
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          Notify Plan PoC
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {planPoc}
                        </Typography>
                      </Box>
                    }
                  />
                )}

                {statusReportType === "phase" && phasePoc && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={statusReportOptions.notifyPhasePoc}
                        onChange={(e) =>
                          setStatusReportOptions((prev) => ({
                            ...prev,
                            notifyPhasePoc: e.target.checked,
                          }))
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          Notify Phase PoC
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {phasePoc}
                        </Typography>
                      </Box>
                    }
                  />
                )}

                {statusReportType === "plan" && allPhasePocs.length > 0 && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={statusReportOptions.notifyPhasePocs}
                        onChange={(e) =>
                          setStatusReportOptions((prev) => ({
                            ...prev,
                            notifyPhasePocs: e.target.checked,
                          }))
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2" fontWeight="medium">
                          Notify All Phase PoCs
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {allPhasePocs.join(", ")}
                        </Typography>
                      </Box>
                    }
                  />
                )}

                {!userEmail && !planPoc &&
                 (statusReportType === "phase" ? !phasePoc : allPhasePocs.length === 0) && (
                  <Typography variant="body2" color="text.secondary">
                    No recipients available to notify.
                  </Typography>
                )}
              </FormGroup>
            );
          })()}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelStatusReport} disabled={sendingStatusReport}>
            Cancel
          </Button>
          <Button
            onClick={handleSendStatusReport}
            variant="contained"
            disabled={sendingStatusReport}
          >
            {sendingStatusReport ? <CircularProgress size={20} /> : "Send Status Report"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
