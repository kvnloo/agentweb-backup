import { useEffect, useState, useRef } from "react";
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
  Tabs,
  Tab,
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
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  ArrowUpward as ArrowUpwardIcon,
  ArrowDownward as ArrowDownwardIcon,
  PlayArrow as PlayArrowIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
  SmartToy as SmartToyIcon,
  Send as SendIcon,
  AttachFile as AttachFileIcon,
  InsertDriveFile as InsertDriveFileIcon,
  Close as CloseIcon,
} from "@mui/icons-material";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { format } from "date-fns";
import axios from "axios";
import { io, Socket } from "socket.io-client";
import ReactMarkdown from "react-markdown";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl, API_URL } from "../config";

interface WorkItemAttachment {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  url: string;
  uploadedAt: string;
}

interface WorkItem {
  id: string;
  title: string;
  description?: string;
  duration?: number;
  dri?: string;
  status: "pending" | "in_progress" | "completed" | "skipped" | "agent_in_progress" | "pending_review";
  notes?: string;
  dueDate?: string;
  completedAt?: string;
  agentSessionId?: string;
  attachments?: WorkItemAttachment[];
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

interface GTMCommonItem {
  id: string;
  title: string;
  description?: string;
  sortOrder: number;
}

interface GTMCommonCategory {
  id: string;
  name: string;
  description?: string;
  sortOrder: number;
  items: GTMCommonItem[];
}

function TabPanel({ children, value, index }: { children?: React.ReactNode; value: number; index: number }) {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ pt: 3 }}>{children}</Box>}
    </div>
  );
}

export default function GTMPlans() {
  const { token } = useAuth();
  const [tabValue, setTabValue] = useState(0);
  const [plans, setPlans] = useState<GTMPlan[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [startingSession, setStartingSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
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

  // Common Items state
  const [commonCategories, setCommonCategories] = useState<GTMCommonCategory[]>([]);
  const [commonLoading, setCommonLoading] = useState(false);
  const [commonError, setCommonError] = useState<string | null>(null);
  const [commonSaving, setCommonSaving] = useState(false);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<GTMCommonCategory | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryDescription, setCategoryDescription] = useState("");
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editingItemInCategory, setEditingItemInCategory] = useState<string>(""); // category id
  const [editingCommonItem, setEditingCommonItem] = useState<GTMCommonItem | null>(null);
  const [commonItemTitle, setCommonItemTitle] = useState("");
  const [commonItemDescription, setCommonItemDescription] = useState("");

  // Chat dialog state
  const [chatDialogOpen, setChatDialogOpen] = useState(false);
  const [chatDialogSessionId, setChatDialogSessionId] = useState("");
  const [chatDialogTitle, setChatDialogTitle] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string; metadata?: { attachments?: Array<{ url: string; filename: string; size: number; mimetype: string }> } }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatLoadingMessages, setChatLoadingMessages] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Socket.IO for real-time GTM status updates
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) return;
    const socket = io(API_URL, {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });
    socketRef.current = socket;

    socket.on("gtm-session-ready", (data: { sessionId: string; workItemId: string; workItemTitle: string; error?: boolean }) => {
      setPlans(prevPlans => prevPlans.map(plan => ({
        ...plan,
        phases: plan.phases.map(phase => ({
          ...phase,
          workItems: phase.workItems.map(item => {
            if (item.id === data.workItemId && item.status === "agent_in_progress") {
              return { ...item, status: data.error ? "pending" as const : "pending_review" as const, agentSessionId: item.agentSessionId || data.sessionId };
            }
            return item;
          }),
        })),
      })));

      if (!data.error) {
        setSuccessMessage(`Emma has finished working on "${data.workItemTitle}". Click the status to review.`);
        setTimeout(() => setSuccessMessage(null), 8000);
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  // Load chat messages when dialog opens
  useEffect(() => {
    if (!chatDialogOpen || !chatDialogSessionId || !token) return;
    setChatLoadingMessages(true);
    fetch(buildApiUrl(`/api/agent-mode/session/${chatDialogSessionId}`), {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    })
      .then((res) => res.ok ? res.json() : Promise.reject())
      .then((session) => setChatMessages(session.messages || []))
      .catch(() => console.error("Failed to load session messages"))
      .finally(() => setChatLoadingMessages(false));
  }, [chatDialogOpen, chatDialogSessionId, token]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, chatLoading]);

  const handleChatSend = async () => {
    const text = chatInput.trim();
    if (!text || chatLoading) return;
    setChatMessages((prev) => [...prev, { role: "user", content: text }]);
    setChatInput("");
    setChatLoading(true);
    try {
      const response = await fetch(buildApiUrl("/api/agent-mode/generate"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: chatDialogSessionId, userMessage: text }),
      });
      if (!response.ok) throw new Error("Failed");
      const data = await response.json();
      if (data.messages) {
        setChatMessages(data.messages);
      } else {
        setChatMessages((prev) => [...prev, { role: "assistant", content: data.content }]);
      }
    } catch {
      setChatMessages((prev) => [...prev, { role: "assistant", content: "Sorry, something went wrong." }]);
    } finally {
      setChatLoading(false);
    }
  };

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

  // Common Items functions
  const fetchCommonItems = async () => {
    try {
      setCommonLoading(true);
      setCommonError(null);
      const response = await axios.get(buildApiUrl("/api/admin/gtm-common-items"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.data.success) {
        setCommonCategories(response.data.data || []);
      }
    } catch (err: any) {
      console.error("Error fetching common items:", err);
      setCommonError(err.response?.data?.error || "Failed to fetch common items");
    } finally {
      setCommonLoading(false);
    }
  };

  const saveCommonItems = async (categories: GTMCommonCategory[]) => {
    try {
      setCommonSaving(true);
      setCommonError(null);
      const response = await axios.put(
        buildApiUrl("/api/admin/gtm-common-items"),
        { categories },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.data.success) {
        setCommonCategories(response.data.data || []);
      }
    } catch (err: any) {
      console.error("Error saving common items:", err);
      setCommonError(err.response?.data?.error || "Failed to save common items");
    } finally {
      setCommonSaving(false);
    }
  };

  const handleAddCategory = () => {
    setEditingCategory(null);
    setCategoryName("");
    setCategoryDescription("");
    setCategoryDialogOpen(true);
  };

  const handleEditCategory = (category: GTMCommonCategory) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryDescription(category.description || "");
    setCategoryDialogOpen(true);
  };

  const handleSaveCategory = () => {
    if (!categoryName.trim()) return;

    let updated: GTMCommonCategory[];
    if (editingCategory) {
      updated = commonCategories.map((cat) =>
        cat.id === editingCategory.id
          ? { ...cat, name: categoryName.trim(), description: categoryDescription.trim() || undefined }
          : cat
      );
    } else {
      const maxSortOrder = commonCategories.reduce((max, cat) => Math.max(max, cat.sortOrder), 0);
      const newCategory: GTMCommonCategory = {
        id: `cat-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        name: categoryName.trim(),
        description: categoryDescription.trim() || undefined,
        sortOrder: maxSortOrder + 1,
        items: [],
      };
      updated = [...commonCategories, newCategory];
    }
    saveCommonItems(updated);
    setCategoryDialogOpen(false);
  };

  const handleDeleteCategory = (categoryId: string) => {
    const updated = commonCategories.filter((cat) => cat.id !== categoryId);
    saveCommonItems(updated);
  };

  const handleMoveCategoryUp = (index: number) => {
    if (index <= 0) return;
    const sorted = [...commonCategories].sort((a, b) => a.sortOrder - b.sortOrder);
    const temp = sorted[index].sortOrder;
    sorted[index].sortOrder = sorted[index - 1].sortOrder;
    sorted[index - 1].sortOrder = temp;
    saveCommonItems(sorted);
  };

  const handleMoveCategoryDown = (index: number) => {
    const sorted = [...commonCategories].sort((a, b) => a.sortOrder - b.sortOrder);
    if (index >= sorted.length - 1) return;
    const temp = sorted[index].sortOrder;
    sorted[index].sortOrder = sorted[index + 1].sortOrder;
    sorted[index + 1].sortOrder = temp;
    saveCommonItems(sorted);
  };

  const handleAddItem = (categoryId: string) => {
    setEditingItemInCategory(categoryId);
    setEditingCommonItem(null);
    setCommonItemTitle("");
    setCommonItemDescription("");
    setItemDialogOpen(true);
  };

  const handleEditItem = (categoryId: string, item: GTMCommonItem) => {
    setEditingItemInCategory(categoryId);
    setEditingCommonItem(item);
    setCommonItemTitle(item.title);
    setCommonItemDescription(item.description || "");
    setItemDialogOpen(true);
  };

  const handleSaveItem = () => {
    if (!commonItemTitle.trim()) return;

    const updated = commonCategories.map((cat) => {
      if (cat.id !== editingItemInCategory) return cat;

      let newItems: GTMCommonItem[];
      if (editingCommonItem) {
        newItems = cat.items.map((item) =>
          item.id === editingCommonItem.id
            ? { ...item, title: commonItemTitle.trim(), description: commonItemDescription.trim() || undefined }
            : item
        );
      } else {
        const maxSortOrder = cat.items.reduce((max, item) => Math.max(max, item.sortOrder), 0);
        const newItem: GTMCommonItem = {
          id: `ci-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
          title: commonItemTitle.trim(),
          description: commonItemDescription.trim() || undefined,
          sortOrder: maxSortOrder + 1,
        };
        newItems = [...cat.items, newItem];
      }
      return { ...cat, items: newItems };
    });
    saveCommonItems(updated);
    setItemDialogOpen(false);
  };

  const handleDeleteItem = (categoryId: string, itemId: string) => {
    const updated = commonCategories.map((cat) => {
      if (cat.id !== categoryId) return cat;
      return { ...cat, items: cat.items.filter((item) => item.id !== itemId) };
    });
    saveCommonItems(updated);
  };

  const handleMoveItemUp = (categoryId: string, index: number) => {
    if (index <= 0) return;
    const updated = commonCategories.map((cat) => {
      if (cat.id !== categoryId) return cat;
      const sorted = [...cat.items].sort((a, b) => a.sortOrder - b.sortOrder);
      const temp = sorted[index].sortOrder;
      sorted[index].sortOrder = sorted[index - 1].sortOrder;
      sorted[index - 1].sortOrder = temp;
      return { ...cat, items: sorted };
    });
    saveCommonItems(updated);
  };

  const handleMoveItemDown = (categoryId: string, index: number) => {
    const updated = commonCategories.map((cat) => {
      if (cat.id !== categoryId) return cat;
      const sorted = [...cat.items].sort((a, b) => a.sortOrder - b.sortOrder);
      if (index >= sorted.length - 1) return cat;
      const temp = sorted[index].sortOrder;
      sorted[index].sortOrder = sorted[index + 1].sortOrder;
      sorted[index + 1].sortOrder = temp;
      return { ...cat, items: sorted };
    });
    saveCommonItems(updated);
  };

  const handleStartSession = async (planId: string, phaseId: string, workItemId: string) => {
    if (!token) return;
    setStartingSession(workItemId);
    try {
      const response = await axios.post(
        buildApiUrl(`/api/admin/gtm-plans/${planId}/phases/${phaseId}/work-items/${workItemId}/start-session`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { workItemTitle } = response.data.data;
      setSuccessMessage(`Emma is working on "${workItemTitle}". Click the status to see the response when ready.`);
      setTimeout(() => setSuccessMessage(null), 8000);
      // Refresh plans to show updated status
      fetchPlans();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to start session");
    } finally {
      setStartingSession(null);
    }
  };

  const handleUploadAttachment = async (planId: string, phaseId: string, workItemId: string, file: File) => {
    if (!token) return;
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await axios.post(
        buildApiUrl(`/api/admin/gtm-plans/${planId}/phases/${phaseId}/work-items/${workItemId}/attachments`),
        formData,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "multipart/form-data" } }
      );
      const att = response.data.data;
      setPlans((prev) =>
        prev.map((p) =>
          p.planId !== planId ? p : {
            ...p,
            phases: p.phases.map((ph) =>
              ph.id !== phaseId ? ph : {
                ...ph,
                workItems: ph.workItems.map((item) =>
                  item.id !== workItemId ? item : { ...item, attachments: [...(item.attachments || []), att] }
                ),
              }
            ),
          }
        )
      );
      setSuccessMessage("Attachment uploaded");
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to upload attachment");
    }
  };

  const handleDeleteAttachment = async (planId: string, phaseId: string, workItemId: string, attachmentId: string) => {
    if (!token) return;
    try {
      await axios.delete(
        buildApiUrl(`/api/admin/gtm-plans/${planId}/phases/${phaseId}/work-items/${workItemId}/attachments/${attachmentId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setPlans((prev) =>
        prev.map((p) =>
          p.planId !== planId ? p : {
            ...p,
            phases: p.phases.map((ph) =>
              ph.id !== phaseId ? ph : {
                ...ph,
                workItems: ph.workItems.map((item) =>
                  item.id !== workItemId ? item : { ...item, attachments: (item.attachments || []).filter((a) => a.id !== attachmentId) }
                ),
              }
            ),
          }
        )
      );
      setSuccessMessage("Attachment deleted");
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to delete attachment");
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      case "agent_in_progress":
        return "info";
      case "pending_review":
        return "warning";
      case "pending":
        return "warning";
      case "skipped":
        return "default";
      default:
        return "default";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "agent_in_progress":
        return "Agent Working";
      case "pending_review":
        return "Review Ready";
      default:
        return status;
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
      if (itemStatus !== "pending" && itemStatus !== "in_progress") {
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

  return (
    <Box>
      <Typography variant="h4" component="h1" gutterBottom>
        GTM Tracker
      </Typography>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1 }}>
        <Typography variant="body1" color="text.secondary">
          Track GTM plans from all users. Update status, notes, and assign PoC for plan items.
        </Typography>
        <Button
          variant="outlined"
          size="small"
          startIcon={showDone ? <VisibilityOffIcon /> : <VisibilityIcon />}
          onClick={() => setShowDone(!showDone)}
        >
          {showDone ? "Hide Done" : "Show Done"}
        </Button>
      </Box>

      <Box sx={{ borderBottom: 1, borderColor: "divider", mb: 0 }}>
        <Tabs value={tabValue} onChange={(_, v) => {
          setTabValue(v);
          if (v === 1 && commonCategories.length === 0) fetchCommonItems();
        }}>
          <Tab label="Plans" />
          <Tab label="Common Items" />
        </Tabs>
      </Box>

      <TabPanel value={tabValue} index={0}>
      {loading ? (
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="40vh">
          <CircularProgress />
        </Box>
      ) : (
      <>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {successMessage && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccessMessage(null)}>
          {successMessage}
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
                                {phase.workItems
                                  .filter((item) => showDone || (item.status !== "completed" && item.status !== "skipped"))
                                  .map((item) => (
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
                                      {item.attachments && item.attachments.length > 0 && (
                                        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
                                          {item.attachments.map((att) => (
                                            <Chip
                                              key={att.id}
                                              icon={<InsertDriveFileIcon />}
                                              label={att.filename}
                                              size="small"
                                              variant="outlined"
                                              onDelete={() => handleDeleteAttachment(plan.planId, phase.id, item.id, att.id)}
                                              deleteIcon={<CloseIcon sx={{ fontSize: 14 }} />}
                                              sx={{ maxWidth: 200 }}
                                            />
                                          ))}
                                        </Box>
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      <Chip
                                        label={getStatusLabel(item.status)}
                                        color={getStatusColor(item.status) as any}
                                        size="small"
                                        icon={item.status === "agent_in_progress" ? <CircularProgress size={14} color="inherit" /> : undefined}
                                        onClick={
                                          item.agentSessionId && (item.status === "agent_in_progress" || item.status === "pending_review")
                                            ? () => {
                                                setChatDialogSessionId(item.agentSessionId!);
                                                setChatDialogTitle(item.title);
                                                setChatDialogOpen(true);
                                              }
                                            : undefined
                                        }
                                        sx={
                                          item.agentSessionId && (item.status === "agent_in_progress" || item.status === "pending_review")
                                            ? { cursor: "pointer" }
                                            : undefined
                                        }
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
                                        {item.status === "pending" && (
                                          <Tooltip title="Start in Agent Mode">
                                            <IconButton
                                              size="small"
                                              color="success"
                                              disabled={startingSession === item.id}
                                              onClick={() => handleStartSession(plan.planId, phase.id, item.id)}
                                            >
                                              {startingSession === item.id ? (
                                                <CircularProgress size={18} />
                                              ) : (
                                                <PlayArrowIcon fontSize="small" />
                                              )}
                                            </IconButton>
                                          </Tooltip>
                                        )}
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
                                        <Tooltip title={`Attach Files${item.attachments?.length ? ` (${item.attachments.length})` : ""}`}>
                                          <IconButton
                                            size="small"
                                            component="label"
                                          >
                                            <input
                                              type="file"
                                              hidden
                                              multiple
                                              onChange={(e) => {
                                                const files = Array.from(e.target.files || []);
                                                files.forEach((file) => handleUploadAttachment(plan.planId, phase.id, item.id, file));
                                                e.target.value = "";
                                              }}
                                            />
                                            <AttachFileIcon fontSize="small" />
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
                  <MenuItem value="in_progress">In Progress</MenuItem>
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
                <MenuItem value="in_progress">In Progress</MenuItem>
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

      </>
      )}
      </TabPanel>

      <TabPanel value={tabValue} index={1}>
        {commonLoading ? (
          <Box display="flex" justifyContent="center" py={4}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {commonError && (
              <Alert severity="error" sx={{ mb: 2 }} onClose={() => setCommonError(null)}>
                {commonError}
              </Alert>
            )}

            {[...commonCategories].sort((a, b) => a.sortOrder - b.sortOrder).map((category, catIndex) => (
              <Accordion key={category.id} defaultExpanded>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%", mr: 2 }}>
                    <Typography variant="subtitle1" sx={{ flexGrow: 1, fontWeight: "medium" }}>
                      {category.name}
                    </Typography>
                    {category.description && (
                      <Typography variant="body2" color="text.secondary" sx={{ mr: 1 }}>
                        {category.description}
                      </Typography>
                    )}
                    <Chip label={`${category.items.length} items`} size="small" />
                    <Box onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                      <Tooltip title="Move Up">
                        <span>
                          <IconButton size="small" disabled={catIndex === 0 || commonSaving} onClick={(e) => { e.stopPropagation(); handleMoveCategoryUp(catIndex); }}>
                            <ArrowUpwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Move Down">
                        <span>
                          <IconButton size="small" disabled={catIndex === [...commonCategories].sort((a, b) => a.sortOrder - b.sortOrder).length - 1 || commonSaving} onClick={(e) => { e.stopPropagation(); handleMoveCategoryDown(catIndex); }}>
                            <ArrowDownwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Edit Category">
                        <IconButton size="small" onClick={(e) => { e.stopPropagation(); handleEditCategory(category); }}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete Category">
                        <IconButton size="small" color="error" onClick={(e) => { e.stopPropagation(); handleDeleteCategory(category.id); }}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </Box>
                </AccordionSummary>
                <AccordionDetails>
                  {category.items.length > 0 ? (
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Title</TableCell>
                            <TableCell>Description</TableCell>
                            <TableCell align="right">Actions</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {[...category.items].sort((a, b) => a.sortOrder - b.sortOrder).map((item, itemIndex) => (
                            <TableRow key={item.id}>
                              <TableCell>
                                <Typography variant="body2" fontWeight="medium">
                                  {item.title}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" color="text.secondary">
                                  {item.description || "-"}
                                </Typography>
                              </TableCell>
                              <TableCell align="right">
                                <Box sx={{ display: "flex", gap: 0.5, justifyContent: "flex-end" }}>
                                  <Tooltip title="Move Up">
                                    <span>
                                      <IconButton size="small" disabled={itemIndex === 0 || commonSaving} onClick={() => handleMoveItemUp(category.id, itemIndex)}>
                                        <ArrowUpwardIcon fontSize="small" />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                  <Tooltip title="Move Down">
                                    <span>
                                      <IconButton size="small" disabled={itemIndex === category.items.length - 1 || commonSaving} onClick={() => handleMoveItemDown(category.id, itemIndex)}>
                                        <ArrowDownwardIcon fontSize="small" />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                  <Tooltip title="Edit Item">
                                    <IconButton size="small" onClick={() => handleEditItem(category.id, item)}>
                                      <EditIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>
                                  <Tooltip title="Delete Item">
                                    <IconButton size="small" color="error" onClick={() => handleDeleteItem(category.id, item.id)}>
                                      <DeleteIcon fontSize="small" />
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
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                      No items in this category.
                    </Typography>
                  )}
                  <Button
                    startIcon={<AddIcon />}
                    size="small"
                    onClick={() => handleAddItem(category.id)}
                    disabled={commonSaving}
                    sx={{ mt: 1 }}
                  >
                    Add Item
                  </Button>
                </AccordionDetails>
              </Accordion>
            ))}

            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={handleAddCategory}
              disabled={commonSaving}
              sx={{ mt: 2 }}
            >
              Add Category
            </Button>
          </>
        )}
      </TabPanel>

      {/* Category Dialog */}
      <Dialog open={categoryDialogOpen} onClose={() => setCategoryDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingCategory ? "Edit Category" : "Add Category"}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            label="Category Name"
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            sx={{ mt: 2 }}
            placeholder="e.g., Paid Ads"
          />
          <TextField
            fullWidth
            label="Description (optional)"
            value={categoryDescription}
            onChange={(e) => setCategoryDescription(e.target.value)}
            sx={{ mt: 2 }}
            placeholder="Brief description of this category"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCategoryDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleSaveCategory} variant="contained" disabled={!categoryName.trim() || commonSaving}>
            {commonSaving ? <CircularProgress size={20} /> : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Item Dialog */}
      <Dialog open={itemDialogOpen} onClose={() => setItemDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingCommonItem ? "Edit Item" : "Add Item"}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            label="Item Title"
            value={commonItemTitle}
            onChange={(e) => setCommonItemTitle(e.target.value)}
            sx={{ mt: 2 }}
            placeholder="e.g., Set up Google Ads account"
          />
          <TextField
            fullWidth
            label="Description (optional)"
            value={commonItemDescription}
            onChange={(e) => setCommonItemDescription(e.target.value)}
            sx={{ mt: 2 }}
            multiline
            rows={3}
            placeholder="Brief description of this work item"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setItemDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleSaveItem} variant="contained" disabled={!commonItemTitle.trim() || commonSaving}>
            {commonSaving ? <CircularProgress size={20} /> : "Save"}
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

      {/* Agent Mode Chat Dialog */}
      <Dialog
        open={chatDialogOpen}
        onClose={() => { setChatDialogOpen(false); fetchPlans(); }}
        maxWidth="md"
        fullWidth
        PaperProps={{ sx: { height: "80vh", display: "flex", flexDirection: "column" } }}
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, py: 1.5, flexShrink: 0 }}>
          <SmartToyIcon sx={{ color: "secondary.main" }} />
          {chatDialogTitle}
          <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
            — Chat with Emma
          </Typography>
        </DialogTitle>
        <DialogContent dividers sx={{ flex: 1, overflow: "auto", p: 2 }} ref={chatScrollRef}>
          {chatLoadingMessages ? (
            <Box display="flex" justifyContent="center" alignItems="center" height="100%">
              <CircularProgress size={24} />
            </Box>
          ) : chatMessages.length === 0 ? (
            <Box display="flex" justifyContent="center" alignItems="center" height="100%">
              <Typography color="text.secondary">No messages yet</Typography>
            </Box>
          ) : (
            chatMessages
              .filter((m) => m.role !== "system")
              .map((message, index) => (
                <Box
                  key={index}
                  sx={{
                    display: "flex",
                    gap: 1.5,
                    mb: 2,
                    justifyContent: message.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  {message.role === "assistant" && (
                    <SmartToyIcon sx={{ color: "secondary.main", mt: 0.5, fontSize: 20 }} />
                  )}
                  <Paper
                    elevation={0}
                    sx={{
                      px: 2,
                      py: 1,
                      maxWidth: "80%",
                      bgcolor: message.role === "user" ? "primary.main" : "grey.100",
                      color: message.role === "user" ? "primary.contrastText" : "text.primary",
                      borderRadius: 2,
                    }}
                  >
                    {message.role === "assistant" ? (
                      <ReactMarkdown>{message.content || ""}</ReactMarkdown>
                    ) : (
                      <>
                        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                          {message.content}
                        </Typography>
                        {message.metadata?.attachments && message.metadata.attachments.length > 0 && (
                          <Box sx={{ mt: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
                            {message.metadata.attachments.map((att, i) => (
                              <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5, opacity: 0.9 }}>
                                <InsertDriveFileIcon sx={{ fontSize: 14 }} />
                                <Typography
                                  variant="caption"
                                  component="a"
                                  href={att.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  sx={{ color: "inherit", textDecoration: "underline", "&:hover": { opacity: 0.8 } }}
                                >
                                  {att.filename}
                                </Typography>
                                <Typography variant="caption" sx={{ opacity: 0.7 }}>
                                  ({formatFileSize(att.size)})
                                </Typography>
                              </Box>
                            ))}
                          </Box>
                        )}
                      </>
                    )}
                  </Paper>
                  {message.role === "user" && (
                    <PersonIcon sx={{ color: "primary.main", mt: 0.5, fontSize: 20 }} />
                  )}
                </Box>
              ))
          )}
          {chatLoading && (
            <Box sx={{ display: "flex", gap: 1.5, mb: 2 }}>
              <SmartToyIcon sx={{ color: "secondary.main", mt: 0.5, fontSize: 20 }} />
              <Paper elevation={0} sx={{ px: 2, py: 1, bgcolor: "grey.100", borderRadius: 2 }}>
                <CircularProgress size={16} />
              </Paper>
            </Box>
          )}
        </DialogContent>
        <Box sx={{ display: "flex", gap: 1, p: 2, flexShrink: 0 }}>
          <TextField
            fullWidth
            size="small"
            placeholder="Type a message..."
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleChatSend();
              }
            }}
            disabled={chatLoading}
            multiline
            maxRows={3}
          />
          <IconButton
            color="primary"
            onClick={handleChatSend}
            disabled={!chatInput.trim() || chatLoading}
          >
            {chatLoading ? <CircularProgress size={20} /> : <SendIcon />}
          </IconButton>
        </Box>
      </Dialog>
    </Box>
  );
}
