import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import axios, { AxiosError } from "axios";
import { useAuth } from "@/contexts/AuthContext";
import { buildApiUrl, buildPartnerPortalUrl, MAX_FILE_SIZE } from "@/config";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Loader2,
  AlertCircle,
  Play,
  CheckCircle,
  RotateCcw,
  Clock,
  ArrowLeft,
  XCircle,
  History,
  X,
  Folder,
  Upload,
  Trash2,
  Settings,
  Edit,
} from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Separator } from "@/components/ui/separator";
import { TaskScheduler } from "@/components/tasks/TaskScheduler";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Define Execution Status type
type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "queued";

// Define Execution interface
interface Execution {
  executionId: string;
  status: ExecutionStatus;
  completedAt?: string;
  error?: string;

  // Fields from API response
  startTime: string;
  taskId: string;
  llmName?: string;
  userId?: string;
  prompt: string;
  result: string;
  userInteractions?: Interaction[];
  result_files?: {
    url: string;
    filename: string;
    is_html?: boolean;
  }[];
  archived?: boolean;
}

// Add Interaction type for userInteractions
interface Interaction {
  id: string;
  question: string;
  response?: string;
  status: "pending" | "answered";
  timestamp: number;
  screenshot_url?: string;
}

// Define TaskAttachment interface
interface TaskAttachment {
  url: string;
  key: string;
  filename: string;
  uploadedAt: string;
}

// Update TaskDetail interface
interface TaskDetail extends Task {
  parameterValues?: Record<string, string>;
  executions?: Execution[];
  resultSummary?: string;
  resultLink?: string;
  isInteractive?: boolean;
  isDeepResearch?: boolean;
  attachments?: TaskAttachment[];
}

// Base Task interface
interface Task {
  taskId: string;
  name: string;
  status: ExecutionStatus | "archived";
  createdAt: string;
  updatedAt?: string;
  prompt?: string;
  category?: string;
  description?: string;
  templateId?: string;
  llmName?: string;
  requireApproval?: boolean;
  slackChannel?: string;
}

// Helper to get status badge variant (can be moved to utils)
const getExecutionStatusBadge = (status?: ExecutionStatus) => {
  if (!status) return <Badge variant="secondary">Unknown</Badge>;
  switch (status) {
    case "completed":
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200 hover:bg-green-200">
          <CheckCircle className="h-3 w-3 mr-1" /> Completed
        </Badge>
      );
    case "running":
      return (
        <Badge className="bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200">
          <RotateCcw className="h-3 w-3 mr-1 animate-spin" /> Running
        </Badge>
      );
    case "failed":
      return (
        <Badge className="bg-red-100 text-red-800 border-red-200 hover:bg-red-200">
          <AlertCircle className="h-3 w-3 mr-1" /> Failed
        </Badge>
      );
    case "queued":
    case "pending":
      return (
        <Badge className="bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200">
          <Clock className="h-3 w-3 mr-1" /> Queued
        </Badge>
      );
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
};

// Helper for Task status (might differ slightly, e.g., no spin for task pending)
const getTaskStatusBadge = (status: Task["status"]) => {
  if (status === "archived") return <Badge variant="outline">Archived</Badge>;
  // Use execution badge for other statuses, but maybe without spin for pending?
  if (status === "running") return getExecutionStatusBadge(status);
  if (status === "pending" || status === "queued")
    return (
      <Badge className="bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200">
        <Clock className="h-3 w-3 mr-1" /> Queued
      </Badge>
    );
  return getExecutionStatusBadge(status as ExecutionStatus); // Reuse logic for completed/failed
};

// Helper function for formatting dates (can be moved to utils later)
const formatDate = (dateStr?: string) => {
  if (!dateStr) return "N/A";
  try {
    // Attempt to handle various date string formats
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      // Check if date is invalid
      // Try to parse if it's a string that looks like ISO but might miss 'T' or 'Z'
      const parts = dateStr.match(
        /(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):?(\d{2}))?/
      );
      if (parts) {
        const isoStr = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${
          parts[5]
        }:${parts[6]}${parts[7] || "Z"}`;
        const parsedDate = new Date(isoStr);
        if (!isNaN(parsedDate.getTime())) return parsedDate.toLocaleString();
      }
      return "Invalid Date";
    }
    return date.toLocaleString();
  } catch (e) {
    return "Invalid Date";
  }
};

const TaskDetailsPage: React.FC = () => {
  const { taskId } = useParams<{ taskId: string }>();
  const { token, user } = useAuth();
  const navigate = useNavigate();
  
  // Check if user has delegate access
  const hasDelegateAccess = user?.delegateInfo?.isDelegated;
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isUpdatingInteractive, setIsUpdatingInteractive] = useState(false);

  // Require Approval state
  const [isUpdatingApproval, setIsUpdatingApproval] = useState(false);
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string; displayName: string; isPrivate: boolean }>>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [channelSelectionOpen, setChannelSelectionOpen] = useState(false);

  const [selectedInteraction, setSelectedInteraction] =
    useState<Interaction | null>(null);
  const [interactionError, setInteractionError] = useState("");
  const [isInteracting, setIsInteracting] = useState(false);

  // File upload state
  const [uploadError, setUploadError] = useState<string>("");
  const [isUploading, setIsUploading] = useState(false);

  const executionsRef = useRef<Execution[]>(executions);
  const taskRef = useRef<TaskDetail | null>(task);

  useEffect(() => {
    executionsRef.current = executions;
  }, [executions]);

  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  const fetchTaskAndExecutions = async () => {
    if (!token || !taskId) {
      setPageError("Task ID or authentication token missing.");
      setLoading(false);
      return;
    }
    if (!taskRef.current) {
      setLoading(true);
    }
    setPageError(null);
    try {
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const taskData = taskResponse.data as TaskDetail;
      setTask(taskData);

      const executionsResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const sortedExecutions = (executionsResponse.data as Execution[]).sort(
        (a, b) =>
          new Date(b.startTime || 0).getTime() -
          new Date(a.startTime || 0).getTime()
      );
      setExecutions(sortedExecutions);
    } catch (err: unknown) {
      console.error("Failed to fetch task data:", err);
      if (axios.isAxiosError(err)) {
        setPageError(
          err.response?.data?.message || "Failed to load task data."
        );
      } else {
        setPageError("Failed to load task data.");
      }
      setTask(null);
      setExecutions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTaskAndExecutions();

    const intervalId = setInterval(() => {
      const currentExecutions = executionsRef.current;
      const latestExecution =
        currentExecutions.length > 0 ? currentExecutions[0] : null;

      const shouldPoll =
        latestExecution &&
        ["running", "pending", "queued"].includes(latestExecution.status);

      if (shouldPoll && !isInteracting) {
        console.log("Polling: fetching task and executions");
        fetchTaskAndExecutions();
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [taskId, token, isInteracting]);

  // Load Slack channels when component mounts
  useEffect(() => {
    if (token) {
      loadSlackChannels();
    }
  }, [token]);

  const handleRunTask = async () => {
    if (!token || !taskId) {
      toast({
        title: "Error",
        description: "Cannot run task. Missing ID or token.",
        variant: "destructive",
      });
      return;
    }
    setIsRunning(true);
    try {
      await axios.post(
        buildApiUrl(`/api/tasks/${taskId}/execute`),
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      toast({ title: "Success", description: "Task execution started." });
      fetchTaskAndExecutions();
    } catch (err: unknown) {
      console.error("Failed to run task:", err);
      if (axios.isAxiosError(err)) {
        toast({
          title: "Error Running Task",
          description:
            err.response?.data?.message || "Could not start task execution.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error Running Task",
          description: "Could not start task execution.",
          variant: "destructive",
        });
      }
    } finally {
      setIsRunning(false);
    }
  };

  const handleExecutionClick = (execution: Execution) => {
    if (task) {
      // Ensure task is available to get taskId
      navigate(
        `/tasks/${task.taskId}/executions/${execution.executionId}/result`
      );
    }
  };

  const handleInteractiveModeToggle = async () => {
    if (!task) return;
    setIsUpdatingInteractive(true);
    try {
      const newValue = !task.isInteractive;
      await axios.put(
        buildApiUrl(`/api/tasks/${task.taskId}`),
        { isInteractive: newValue },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setTask({ ...task, isInteractive: newValue });
      toast({ title: "Success", description: "Co-Pilot Mode updated." });
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to update Co-Pilot Mode.",
        variant: "destructive",
      });
    } finally {
      setIsUpdatingInteractive(false);
    }
  };

  const loadSlackChannels = async () => {
    setLoadingChannels(true);
    try {
      const response = await axios.get(buildApiUrl('/api/slack/channels'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSlackChannels(response.data);
    } catch (error: any) {
      console.error('Error loading Slack channels:', error);
      toast({
        title: "Error Loading Channels",
        description: "Could not load Slack channels. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoadingChannels(false);
    }
  };

  const handleApprovalToggle = async () => {
    if (!task) return;
    setIsUpdatingApproval(true);
    try {
      const newValue = !task.requireApproval;
      const updates: any = { requireApproval: newValue };
      
      // If enabling approval, open channel selection
      if (newValue) {
        // Load channels if not already loaded
        if (slackChannels.length === 0) {
          await loadSlackChannels();
        }
        // Open channel selection dialog
        setChannelSelectionOpen(true);
      } else {
        // If disabling approval, clear the Slack channel
        updates.slackChannel = null;
        await axios.put(
          buildApiUrl(`/api/tasks/${task.taskId}`),
          updates,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        // Refresh task data from server to ensure consistency
        await fetchTaskAndExecutions();
        toast({ title: "Success", description: "Require Approval setting updated." });
      }
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to update Require Approval setting.",
        variant: "destructive",
      });
    } finally {
      setIsUpdatingApproval(false);
    }
  };

  const handleSlackChannelSelect = async (channelId: string) => {
    if (!task) return;
    setIsUpdatingApproval(true);
    try {
      const selectedChannel = slackChannels.find(ch => ch.id === channelId);
      const channelName = selectedChannel?.name || channelId;
      
      // Update both requireApproval and slackChannel
      await axios.put(
        buildApiUrl(`/api/tasks/${task.taskId}`),
        { 
          requireApproval: true,
          slackChannel: channelId 
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Refresh task data from server to ensure consistency
      await fetchTaskAndExecutions();
      setChannelSelectionOpen(false);
      toast({ title: "Success", description: `Require Approval enabled and Slack channel set to ${channelName}` });
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to update Slack channel.",
        variant: "destructive",
      });
    } finally {
      setIsUpdatingApproval(false);
    }
  };

  const handleCancelApproval = () => {
    setChannelSelectionOpen(false);
    // If the user cancels after enabling approval, revert the setting
    if (task && task.requireApproval && !task.slackChannel) {
      setTask({ ...task, requireApproval: false });
    }
  };

  const handleUserResponse = async (
    executionId: string,
    interactionId: string,
    userResponseText: string
  ) => {
    try {
      await axios.put(
        buildApiUrl(
          `/api/tasks/${task?.taskId}/executions/${executionId}/interactions/${interactionId}`
        ),
        { response: userResponseText },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      console.log("User response sent successfully to API:", {
        executionId,
        interactionId,
        response: userResponseText,
      });
      fetchTaskAndExecutions();
      setSelectedInteraction(null);
      setInteractionError("");
      setIsInteracting(false);
    } catch (err) {
      console.error("Failed to send user response:", err);
      setInteractionError("Failed to send response. Please try again.");
      toast({
        title: "Error",
        description: "Failed to send response.",
        variant: "destructive",
      });
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    // Check number of files
    if (files.length > 5) {
      setUploadError("You can only upload up to 5 files at once");
      return;
    }

    // Check file sizes
    const oversizedFiles = files.filter((file) => file.size > MAX_FILE_SIZE);
    if (oversizedFiles.length > 0) {
      setUploadError(
        `Following files exceed ${MAX_FILE_SIZE / (1024 * 1024)}MB limit: ${oversizedFiles
          .map((f) => f.name)
          .join(", ")}`
      );
      return;
    }

    // Check total number of attachments
    const currentAttachments = task?.attachments?.length || 0;
    if (currentAttachments + files.length > 5) {
      setUploadError(
        `You can only have up to 5 attachments total. You currently have ${currentAttachments} attachments.`
      );
      return;
    }

    setIsUploading(true);
    setUploadError("");

    try {
      // Upload files sequentially to avoid overwhelming the server
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        await axios.post(
          buildApiUrl(`/api/tasks/${taskId}/attachments`),
          formData,
          {
            headers: {
              "Content-Type": "multipart/form-data",
              Authorization: `Bearer ${token}`,
            },
          }
        );
      }
      await fetchTaskAndExecutions(); // Refresh task to get updated attachments
      toast({
        title: "Success",
        description: "Files uploaded successfully.",
      });
    } catch (error: any) {
      if (error.response?.status === 413) {
        setUploadError(`File size too large. Maximum file size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`);
      } else {
        setUploadError(
          error.response?.data?.error || "Failed to upload file(s)"
        );
      }
      toast({
        title: "Error",
        description: "Failed to upload files.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      // Clear the input value to allow uploading the same file again
      if (event.target) {
        event.target.value = "";
      }
    }
  };

  const handleDeleteAttachment = async (key: string) => {
    try {
      await axios.delete(
        buildApiUrl(
          `/api/tasks/${taskId}/attachments/${encodeURIComponent(key)}`
        ),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      await fetchTaskAndExecutions(); // Refresh task to get updated attachments
      toast({
        title: "Success",
        description: "Attachment deleted successfully.",
      });
    } catch (error: any) {
      console.error("Failed to delete attachment:", error);
      toast({
        title: "Error",
        description: "Failed to delete attachment.",
        variant: "destructive",
      });
    }
  };

  interface UserInteractionDialogProps {
    execution: Execution;
    onRespond: (
      executionId: string,
      interactionId: string,
      responseText: string
    ) => Promise<void>;
    activeInteraction: Interaction | null;
    setActiveInteraction: (interaction: Interaction | null) => void;
    currentError: string;
    setCurrentError: (error: string) => void;
    setParentIsInteracting: (isInteracting: boolean) => void;
  }

  const UserInteractionDialog: React.FC<UserInteractionDialogProps> = ({
    execution,
    onRespond,
    activeInteraction,
    setActiveInteraction,
    currentError,
    setCurrentError,
    setParentIsInteracting,
  }) => {
    const [dialogInputValue, setDialogInputValue] = useState("");

    useEffect(() => {
      if (activeInteraction) {
        setDialogInputValue("");
        setCurrentError("");
      } else {
        setDialogInputValue("");
      }
    }, [activeInteraction, setCurrentError]);

    if (
      !activeInteraction ||
      !execution.userInteractions?.length ||
      execution.status !== "running"
    ) {
      return null;
    }

    const pendingCount = execution.userInteractions.filter(
      (i) => i.status === "pending"
    ).length;

    const handleDialogSubmit = async () => {
      if (!activeInteraction || !dialogInputValue.trim()) return;
      setCurrentError("");
      try {
        await onRespond(
          execution.executionId,
          activeInteraction.id,
          dialogInputValue.trim()
        );
      } catch (err) {
        // Parent handles error display through setInteractionError
      }
    };

    const handleCancel = () => {
      setActiveInteraction(null);
      setCurrentError("");
      setParentIsInteracting(false);
    };

    const currentInteractionDetails = execution.userInteractions.find(
      (i) => i.id === activeInteraction.id
    );
    if (!currentInteractionDetails) return null;

    return (
      <div className="rounded border p-4 my-4 bg-muted">
        <div className="flex items-center justify-between mb-2">
          <span className="font-semibold">Agent Question</span>
          <span>
            <span
              className={`inline-block px-2 py-1 rounded text-xs ${
                pendingCount > 0
                  ? "bg-yellow-200 text-yellow-800"
                  : "bg-green-200 text-green-800"
              }`}
            >
              {pendingCount > 0
                ? `${pendingCount} Total Pending`
                : "All Answered"}
            </span>
          </span>
        </div>
        <div className="border-b pb-2 last:border-b-0">
          <div className="font-medium mb-1">
            {currentInteractionDetails.question}
          </div>
          {currentInteractionDetails.screenshot_url && (
            <img
              src={currentInteractionDetails.screenshot_url}
              alt="Screenshot"
              className="max-w-xs mb-2 border rounded"
            />
          )}
          <div>
            <textarea
              className="w-full border rounded p-2 mb-2 bg-slate-800 text-slate-100 border-slate-600 placeholder-slate-400 focus:ring-indigo-500 focus:border-indigo-500"
              rows={3}
              value={dialogInputValue}
              onChange={(e) => setDialogInputValue(e.target.value)}
              placeholder="Type your response here..."
              autoFocus
            />
            {currentError && (
              <div className="text-red-600 text-xs mb-1">{currentError}</div>
            )}
            <div className="flex gap-2">
              <Button
                className="secondary-button"
                size="sm"
                onClick={handleCancel}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleDialogSubmit}
                disabled={!dialogInputValue.trim()}
                className="use-template-button"
              >
                Send Response
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (loading && !task) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (pageError || !task) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error Loading Task</AlertTitle>
        <AlertDescription>{pageError || "Task not found."}</AlertDescription>
      </Alert>
    );
  }

  // Filter out archived executions like in partner-portal
  const nonArchivedExecutions = executions.filter(execution => !execution.archived);
  const latestExecution = nonArchivedExecutions.length > 0 ? nonArchivedExecutions[0] : null;

  return (
    <div className="container mx-auto py-8 space-y-6 relative">
      {nonArchivedExecutions.map(
        (exec, index) =>
          exec.result && (
            <div
              key={`hidden-exec-result-${exec.executionId || index}`}
              id={`full-exec-result-${exec.executionId || index}`}
              className="hidden-execution-result"
              style={{ display: "none" }}
              aria-hidden="true"
            >
              {exec.result}
            </div>
          )
      )}

      <Button
        className="secondary-button"
        size="sm"
        onClick={() => navigate("/tasks")}
      >
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to Tasks
      </Button>

      <Card>
        <CardHeader>
          <div className="flex justify-between items-start gap-2 mb-2">
            <div className="flex items-center gap-3">
              <CardTitle className="text-2xl font-bold">{task.name}</CardTitle>
              {hasDelegateAccess && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => window.open(buildPartnerPortalUrl(`/tasks/${taskId}`), '_blank')}
                  title="Manage Task in Partner Portal"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              )}
            </div>
            {getTaskStatusBadge(task.status)}
          </div>
          <CardDescription className="text-xs text-muted-foreground">
            Task ID: {task.taskId} | Created: {formatDate(task.createdAt)}
          </CardDescription>
          {task.llmName && (
            <div className="mt-2">
              <Badge variant="outline" className="text-xs">
                Preferred LLM: {task.llmName}
              </Badge>
            </div>
          )}
          {task.category && (
            <div className="mt-2">
              <Badge variant="secondary">
                <Folder className="mr-1.5 h-3.5 w-3.5" />
                {task.category}
              </Badge>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Attachments Section */}
          <div className="pb-4 border-b">
            <h3 className="font-semibold mb-2 text-sm">Attachments</h3>
            
            {/* Upload Section */}
            <div className="mb-4">
              <input
                accept="*/*"
                style={{ display: "none" }}
                id="file-upload"
                type="file"
                onChange={handleFileUpload}
                multiple
                disabled={isUploading || (task?.attachments?.length || 0) >= 5}
              />
              <label htmlFor="file-upload">
                <Button
                  variant="outline"
                  disabled={
                    isUploading || (task?.attachments?.length || 0) >= 5
                  }
                  className="cursor-pointer"
                  asChild
                >
                  <span>
                    {isUploading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-4 w-4" />
                    )}
                    {isUploading ? "Uploading..." : "Upload Files"}
                  </span>
                </Button>
              </label>
              {(task?.attachments?.length || 0) >= 5 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Maximum number of attachments (5) reached
                </p>
              )}
              {uploadError && (
                <Alert variant="destructive" className="mt-2">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{uploadError}</AlertDescription>
                </Alert>
              )}
            </div>

            {/* Attachments List */}
            {task.attachments && task.attachments.length > 0 ? (
              <ul className="space-y-2">
                {task.attachments.map((att) => (
                  <li key={att.key} className="flex items-center justify-between p-2 bg-muted rounded">
                    <div className="flex-1">
                      <a
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline text-sm"
                      >
                        {att.filename}
                      </a>
                      <p className="text-xs text-muted-foreground">
                        Added on {new Date(att.uploadedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteAttachment(att.key)}
                      className="text-red-500 hover:text-red-600 ml-2"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No attachments yet
              </p>
            )}
          </div>
          {task.description && (
            <div className="pb-4 border-b">
              <h3 className="font-semibold mb-1 text-sm">Description:</h3>
              <p className="text-sm text-muted-foreground">
                {task.description}
              </p>
            </div>
          )}
          <div className={`pt-4 ${task.description ? "" : "border-t"}`}>
            {(() => {
              const isTaskActive = ["running", "pending", "queued"].includes(
                task.status
              );
              const isLatestExecutionActive =
                latestExecution &&
                ["running", "pending", "queued"].includes(
                  latestExecution.status
                );
              const isDisabled =
                isRunning || isTaskActive || isLatestExecutionActive;

              return (
                <>
                  <Button
                    onClick={handleRunTask}
                    disabled={isDisabled}
                    className="use-template-button"
                  >
                    {isRunning ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="mr-2 h-4 w-4" />
                    )}
                    Run Task
                  </Button>
                  {isDisabled && !isRunning && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {isTaskActive
                        ? "Task is currently running or queued."
                        : isLatestExecutionActive
                        ? "The latest execution is currently running or queued."
                        : ""}
                    </p>
                  )}
                </>
              );
            })()}
          </div>
          <TaskScheduler taskId={task.taskId} />
          <div className="flex items-center gap-2 mb-2">
            <Switch
              id="interactive-mode"
              checked={!!task.isInteractive}
              onCheckedChange={handleInteractiveModeToggle}
              disabled={isUpdatingInteractive || !!task.isDeepResearch}
            />
            <Label htmlFor="interactive-mode">Co-Pilot Mode</Label>
            {isUpdatingInteractive && (
              <span className="text-xs text-muted-foreground ml-2">
                Updating...
              </span>
            )}
          </div>
          
          {/* Require Approval Section */}
          <div className="flex items-center gap-2 mb-2">
            <Switch
              id="require-approval"
              checked={!!task.requireApproval}
              onCheckedChange={handleApprovalToggle}
              disabled={isUpdatingApproval}
            />
            <Label htmlFor="require-approval">Require Approval</Label>
            {isUpdatingApproval && (
              <span className="text-xs text-muted-foreground ml-2">
                Updating...
              </span>
            )}
          </div>
          
          {/* Slack Channel Selection */}
          {task.requireApproval && (
            <div className="mb-4">
              <Label className="text-sm font-medium">Slack Channel for Approval</Label>
              <div className="flex items-center gap-2 mt-1">
                {task.slackChannel ? (
                  <>
                    <span className="text-sm text-muted-foreground">
                      {slackChannels.find(ch => ch.id === task.slackChannel)?.name || task.slackChannel}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setChannelSelectionOpen(true)}
                      disabled={isUpdatingApproval}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-orange-600">No channel selected</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setChannelSelectionOpen(true)}
                      disabled={isUpdatingApproval}
                    >
                      Select Channel
                    </Button>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                When enabled, task results will be sent to Slack for approval instead of directly to subscribers.
              </p>
            </div>
          )}
          
          {latestExecution &&
            latestExecution.status === "running" &&
            latestExecution.userInteractions?.some(
              (i) => i.status === "pending"
            ) &&
            !selectedInteraction && (
              <div className="my-4">
                <Button
                  className="use-template-button"
                  onClick={() => {
                    const firstPending = latestExecution.userInteractions?.find(
                      (i) => i.status === "pending"
                    );
                    if (firstPending) {
                      setSelectedInteraction(firstPending);
                      setIsInteracting(true);
                      setInteractionError("");
                    }
                  }}
                >
                  Respond to Agent Questions (
                  {
                    latestExecution.userInteractions?.filter(
                      (i) => i.status === "pending"
                    ).length
                  }
                  )
                </Button>
              </div>
            )}
          {latestExecution && selectedInteraction && (
            <UserInteractionDialog
              execution={latestExecution}
              onRespond={handleUserResponse}
              activeInteraction={selectedInteraction}
              setActiveInteraction={setSelectedInteraction}
              currentError={interactionError}
              setCurrentError={setInteractionError}
              setParentIsInteracting={setIsInteracting}
            />
          )}
        </CardContent>
      </Card>

      <div>
        <h2 className="text-2xl font-semibold mb-4">Executions</h2>
        {nonArchivedExecutions && nonArchivedExecutions.length > 0 ? (
          <div className="space-y-4">
            {nonArchivedExecutions.map((exec) => (
              <Card
                key={exec.executionId}
                className="bg-slate-50 dark:bg-slate-800/50 hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => handleExecutionClick(exec)}
              >
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-center gap-2">
                    <div className="flex items-center gap-2">
                      <CardDescription>
                        Execution ID: {exec.executionId}
                      </CardDescription>
                      {hasDelegateAccess && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-foreground h-6 px-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(buildPartnerPortalUrl(`/tasks/${taskId}/executions/${exec.executionId}`), '_blank');
                          }}
                          title="Manage Execution in Partner Portal"
                        >
                          <Settings className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                    {getExecutionStatusBadge(exec.status)}
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {exec.startTime && (
                    <p>Started: {formatDate(exec.startTime)}</p>
                  )}
                  {exec.completedAt && (
                    <p>Completed: {formatDate(exec.completedAt)}</p>
                  )}
                  {exec.llmName && (
                    <p className="text-xs mt-2">
                      <span className="font-semibold">LLM:</span> {exec.llmName}
                    </p>
                  )}
                  {exec.status === "failed" && exec.error && (
                    <Alert variant="destructive" className="mt-2 p-2 text-xs">
                      <AlertCircle className="h-3 w-3" />
                      <AlertDescription>{exec.error}</AlertDescription>
                    </Alert>
                  )}
                  {exec.result && (
                    <p className="pt-2 mt-2 border-t border-dashed">
                      Result: {exec.result.substring(0, 100)}
                      {exec.result.length > 100 ? "..." : ""}
                    </p>
                  )}
                  {exec.result_files && exec.result_files.length > 0 && (
                    <div className="pt-2 mt-2 border-t border-dashed">
                      <p className="text-xs font-semibold mb-1">
                        Result Files:
                      </p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {exec.result_files.map((file, idx) => (
                          <li key={idx} className="text-xs">
                            <a
                              href={file.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-500 hover:underline"
                            >
                              {file.filename}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">
            No executions found for this task.
          </p>
        )}
      </div>
      
      {/* Slack Channel Selection Dialog */}
      <Dialog open={channelSelectionOpen} onOpenChange={setChannelSelectionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select Slack Channel</DialogTitle>
            <DialogDescription>
              {task?.slackChannel 
                ? "Choose a different Slack channel to send approval requests to when this task completes."
                : "Choose a Slack channel to send approval requests to when this task completes. This will enable Require Approval for this task."
              }
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {loadingChannels ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : slackChannels.length > 0 ? (
              <div className="space-y-2">
                {slackChannels.map((channel) => (
                  <Button
                    key={channel.id}
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => handleSlackChannelSelect(channel.id)}
                    disabled={isUpdatingApproval}
                  >
                    <span className="font-medium">{channel.displayName || channel.name}</span>
                    {channel.isPrivate && (
                      <Badge variant="secondary" className="ml-2">
                        Private
                      </Badge>
                    )}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="text-center py-4 text-muted-foreground">
                No Slack channels available. Please check your Slack integration.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancelApproval}
              disabled={isUpdatingApproval}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TaskDetailsPage;
