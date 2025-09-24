import { useState, useEffect, useRef } from "react";
import {
  useParams,
  useNavigate,
  useLocation,
  Link as RouterLink,
} from "react-router-dom";
import {
  Container,
  Typography,
  Paper,
  Box,
  Chip,
  Button,
  Grid,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Switch,
  FormControlLabel,
  TextField,
  IconButton,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Tooltip,
  Link,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import ArchiveIcon from "@mui/icons-material/Archive";
import UnarchiveIcon from "@mui/icons-material/Unarchive";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ThumbUpIcon from "@mui/icons-material/ThumbUp";
import ThumbDownIcon from "@mui/icons-material/ThumbDown";
import EditIcon from "@mui/icons-material/Edit";
import SaveIcon from "@mui/icons-material/Save";
import CancelIcon from "@mui/icons-material/Cancel";
import ScreenshotIcon from "@mui/icons-material/Screenshot";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import { styled } from "@mui/material/styles";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import ScheduleForm from "../components/ScheduleForm";
import ScheduleList from "../components/ScheduleList";
import { buildApiUrl, getLLMsForTask, MAX_FILE_SIZE } from "../config";
import { fetchImageModelConfig, ImageModel, getEffectiveImageModel } from "../services/imageModelService";
import { toast } from "react-hot-toast";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import { LeadListSection } from "../components/tasks/LeadListSection";

interface Task {
  taskId: string;
  userId: string;
  name: string;
  prompt: string;
  status: string; // Task status: active, archived, etc.
  createdAt: string;
  updatedAt?: string;
  summary?: string;
  error?: string;
  emailNotification?: boolean;
  isInteractive?: boolean;
  isDeepResearch?: boolean;
  isComplexTask?: boolean;
  extractPageContent?: boolean; // New flag for extracting page content
  validateOutput?: boolean; // Flag for validating agent output
  outputAsJson?: boolean; // Flag for outputting result as JSON
  outputAsHtml?: boolean; // New flag for outputting result as HTML5
  emailFriendlyHtml?: boolean; // Flag for creating email-friendly HTML revisions
  repairImageEmbedding?: boolean; // Flag for repairing image embeddings in HTML
  htmlTemplateFilename?: string; // filename of selected HTML template attachment
  isAgenticDevMode?: boolean; // Flag for enabling agentic dev mode
  llmName?: string;
  attachments?: TaskAttachment[];
  selectedLLMs?: string[];
  useSharedBrowser?: boolean; // Flag for using shared browser
  turnOffHeadless?: boolean; // Flag for turning off headless mode
  useKnowledgeBase?: boolean; // Flag for using knowledge base
  updateKnowledgeBase?: boolean; // Flag for updating knowledge base
  updateLeadList?: boolean; // Flag for updating lead list
  leadListIdentifier?: string;
  createVideo?: boolean; // Flag for creating video recording of task execution
  videoModel?: string; // The video model to use for video generation
  imageModel?: string; // The image model to use for image generation
  knowledgeBase?: string; // The content of the task's knowledge base
  knowledgeBaseSize?: number; // Size of the knowledge base in bytes
  knowledgeBaseType?: "public" | "private"; // Type of knowledge base
  knowledgeBaseUpdatedAt?: string; // Timestamp of the last update to the knowledge base
  description?: string;
  category?: string;
}

interface TaskAttachment {
  url: string;
  key: string;
  filename: string;
  uploadedAt: string;
}

interface UserInteraction {
  id: string;
  question: string;
  response?: string;
  status: "pending" | "answered";
  timestamp: number;
  screenshot_url?: string;
}

interface TaskExecution {
  executionId: string;
  taskId: string;
  userId: string;
  status: string; // Execution status: pending, running, completed, failed
  startTime: string;
  completedAt?: string;
  result?: string;
  error?: string;
  feedback?: "accepted" | "rejected";
  details_gif?: string;
  prompt?: string;
  userInteractions?: UserInteraction[];
  result_files?: {
    url: string;
    filename: string;
    token: string;
    is_html?: boolean;
  }[];
  llmName?: string;
  imageModel?: string;
  archived: boolean;
  knowledge_base_updated_at?: string;
}

interface Subscriber {
  email: string;
  subscribedAt: string;
}

const PreviewImage = styled("img")({
  maxHeight: "500px",
  maxWidth: "800px",
  objectFit: "contain",
});

// Add this helper function before the CollapsibleText component
const truncateFilename = (filename: string, maxLength: number = 20): string => {
  if (filename.length <= maxLength) return filename;

  const extension = filename.includes(".") ? filename.split(".").pop() : "";
  const nameWithoutExt = filename.substring(0, filename.lastIndexOf("."));

  // Calculate how much of the name we can keep
  const maxNameLength = maxLength - (extension ? extension.length + 1 : 0) - 3; // 3 for "..."
  const truncatedName = nameWithoutExt.substring(0, maxNameLength);

  return `${truncatedName}...${extension ? `.${extension}` : ""}`;
};

// Add CollapsibleText component
const CollapsibleText = ({
  text,
  maxLength = 150,
}: {
  text: string;
  maxLength?: number;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const needsCollapse = text.length > maxLength;

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
  };

  return (
    <span style={{ display: "inline-block" }}>
      <Typography
        variant="body2"
        component="span"
        sx={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          display: "inline-block",
        }}
      >
        {isExpanded
          ? text
          : needsCollapse
          ? `${text.slice(0, maxLength)}...`
          : text}
      </Typography>
      <Box sx={{ mt: 1, display: "flex", gap: 1 }}>
        {needsCollapse && (
          <Button
            size="small"
            onClick={() => setIsExpanded(!isExpanded)}
            sx={{ minWidth: "auto", p: 0 }}
          >
            {isExpanded ? "Show Less" : "Show More"}
          </Button>
        )}
        <Tooltip title="Copy to clipboard">
          <IconButton size="small" onClick={handleCopy} sx={{ p: 0 }}>
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </span>
  );
};

// Add UserInteractionDialog component
const UserInteractionDialog = ({
  execution,
  onRespond,
}: {
  execution: TaskExecution;
  onRespond: (
    executionId: string,
    interactionId: string,
    response: string
  ) => Promise<void>;
}) => {
  const [response, setResponse] = useState("");
  const [selectedInteraction, setSelectedInteraction] =
    useState<UserInteraction | null>(null);
  const [error, setError] = useState("");

  const handleRespond = async () => {
    if (!selectedInteraction || !response.trim()) return;

    try {
      await onRespond(
        execution.executionId,
        selectedInteraction.id,
        response.trim()
      );
      setResponse("");
      setSelectedInteraction(null);
      setError("");
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to send response");
    }
  };

  if (!execution.userInteractions?.length || execution.status !== "running")
    return null;

  // Count pending questions
  const pendingCount = execution.userInteractions.filter(
    (i) => i.status === "pending"
  ).length;

  return (
    <Box
      sx={{
        mt: 2,
        bgcolor: "background.paper",
        borderRadius: 1,
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          p: 2,
          bgcolor: "primary.main",
          color: "primary.contrastText",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: "medium" }}>
          Agent Questions
        </Typography>
        {pendingCount > 0 ? (
          <Chip
            label={`${pendingCount} Pending`}
            color="warning"
            size="small"
            sx={{ ml: 2 }}
          />
        ) : (
          <Chip
            label="All Answered"
            color="success"
            size="small"
            sx={{ ml: 2 }}
          />
        )}
      </Box>

      <List sx={{ p: 0 }}>
        {execution.userInteractions.map((interaction, index) => (
          <ListItem
            key={interaction.id}
            sx={{
              borderBottom:
                index < execution.userInteractions!.length - 1
                  ? "1px solid rgba(0, 0, 0, 0.12)"
                  : "none",
              bgcolor:
                selectedInteraction?.id === interaction.id
                  ? "action.selected"
                  : "transparent",
              transition: "background-color 0.2s",
              p: 2,
            }}
          >
            <Box sx={{ width: "100%" }}>
              <Box
                sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}
              >
                <Typography variant="body1" sx={{ fontWeight: "medium" }}>
                  {interaction.question}
                </Typography>
                {interaction.screenshot_url && (
                  <Tooltip
                    title={
                      <PreviewImage
                        src={interaction.screenshot_url}
                        alt="Screenshot"
                      />
                    }
                    placement="right"
                    arrow
                  >
                    <IconButton size="small">
                      <ScreenshotIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>

              {interaction.response ? (
                <Box
                  sx={{
                    ml: 2,
                    p: 1.5,
                    bgcolor: "success.light",
                    color: "success.contrastText",
                    borderRadius: 1,
                    position: "relative",
                  }}
                >
                  <Typography variant="body2">
                    {interaction.response}
                  </Typography>
                </Box>
              ) : (
                interaction.status === "pending" && (
                  <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
                    {selectedInteraction?.id === interaction.id ? (
                      <Box sx={{ width: "100%" }}>
                        <TextField
                          fullWidth
                          multiline
                          rows={2}
                          placeholder="Type your response here..."
                          value={response}
                          onChange={(e) => setResponse(e.target.value)}
                          error={!!error}
                          helperText={error}
                          sx={{ mb: 1 }}
                          autoFocus
                        />
                        <Box
                          sx={{
                            display: "flex",
                            gap: 1,
                            justifyContent: "flex-end",
                          }}
                        >
                          <Button
                            variant="outlined"
                            size="small"
                            onClick={() => {
                              setSelectedInteraction(null);
                              setResponse("");
                              setError("");
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="contained"
                            size="small"
                            onClick={handleRespond}
                            disabled={!response.trim()}
                          >
                            Send Response
                          </Button>
                        </Box>
                      </Box>
                    ) : (
                      <Button
                        variant="outlined"
                        size="small"
                        onClick={() => setSelectedInteraction(interaction)}
                        startIcon={<EditIcon />}
                        sx={{ ml: 2 }}
                      >
                        Respond
                      </Button>
                    )}
                  </Box>
                )
              )}
            </Box>
          </ListItem>
        ))}
      </List>
    </Box>
  );
};

export default function TaskDetails() {
  const [task, setTask] = useState<Task | null>(null);
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scheduleRefreshTrigger, setScheduleRefreshTrigger] = useState(0);
  const { taskId } = useParams<{ taskId: string }>();
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [newSubscriberEmail, setNewSubscriberEmail] = useState("");
  const [subscriberError, setSubscriberError] = useState("");
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState("");
  const [uploadError, setUploadError] = useState<string>("");
  const [isUploading, setIsUploading] = useState(false);
  const [shouldPoll, setShouldPoll] = useState(false);
  const hasReloaded = useRef(false);
  const [success, setSuccess] = useState("");
  const [ownerChangeDialogOpen, setOwnerChangeDialogOpen] = useState(false);
  const [newOwnerEmail, setNewOwnerEmail] = useState("");
  const [ownerChangeError, setOwnerChangeError] = useState("");
  const [ownerChangeSuccess, setOwnerChangeSuccess] = useState("");
  const [isEditingKnowledgeBase, setIsEditingKnowledgeBase] = useState(false);
  const [editedKnowledgeBase, setEditedKnowledgeBase] = useState("");
  const [knowledgeBaseError, setKnowledgeBaseError] = useState("");
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [defaultImageModel, setDefaultImageModel] = useState<string>("openai-image-1");
  const [isUpdatingKnowledgeBase, setIsUpdatingKnowledgeBase] = useState<
    string | null
  >(null);
  const [isLeadListDialogOpen, setIsLeadListDialogOpen] = useState(false);
  const [leadListIdentifier, setLeadListIdentifier] = useState("");
  const [leadListIdentifierError, setLeadListIdentifierError] = useState("");
  const [isEmailFriendlyDialogOpen, setIsEmailFriendlyDialogOpen] = useState(false);
  const [isVideoModelDialogOpen, setIsVideoModelDialogOpen] = useState(false);
  const [selectedVideoModel, setSelectedVideoModel] = useState("");
  const [tempEmailFriendly, setTempEmailFriendly] = useState(false);
  const [tempRepairImageEmbedding, setTempRepairImageEmbedding] = useState(false);
  const [tempHtmlTemplateFilename, setTempHtmlTemplateFilename] = useState<string | null>(null);

  const isAdminRoute = location.pathname.startsWith("/admin/");
  const showActions =
    !isAdminRoute || (task && user && task.userId === user.userId);

  const fetchTask = async () => {
    if (!taskId) return;
    try {
      const [taskResponse, executionsResponse] = await Promise.all([
        axios.get(buildApiUrl(`/api/tasks/${taskId}`), {
          headers: { Authorization: `Bearer ${token}` },
        }),
        axios.get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      const updatedTask = taskResponse.data;
      console.log("Task data fetched:", updatedTask);
      setTask(updatedTask);
      setExecutions(executionsResponse.data);
      return updatedTask;
    } catch (error: any) {
      console.error("Error fetching task details:", error);
      setError(error.response?.data?.message || "Failed to fetch task details");
      return null;
    }
  };

  useEffect(() => {
    const fetchTaskAndExecutions = async () => {
      setLoading(true);
      await fetchTask();
      setLoading(false);
    };

    fetchTaskAndExecutions();

    // Set up polling for executions
    const intervalId = setInterval(() => {
      if (taskId && shouldPoll) {
        axios
          .get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
            headers: { Authorization: `Bearer ${token}` },
          })
          .then((response) => setExecutions(response.data))
          .catch((error) => console.error("Error polling executions:", error));
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [taskId, token, shouldPoll]);

  // Control polling interval based on execution status
  useEffect(() => {
    // Only poll if the latest execution is pending or running
    const latestExecution = getLatestExecution();
    const newShouldPoll = Boolean(
      latestExecution &&
        ["pending", "running"].includes(latestExecution.status.toLowerCase())
    );

    if (newShouldPoll) {
      console.log("Latest execution is active - polling enabled");
      setShouldPoll(true);
      hasReloaded.current = false; // Reset reload flag when polling starts
    } else if (shouldPoll && !hasReloaded.current) {
      // If we were polling but now we shouldn't, and haven't reloaded yet
      console.log("Execution completed - reloading page in 1s");
      setShouldPoll(false);
      hasReloaded.current = true; // Mark that we've reloaded
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    }
  }, [executions]);

  useEffect(() => {
    const fetchSubscribers = async () => {
      if (!taskId) return;
      try {
        const response = await axios.get(
          buildApiUrl(`/api/tasks/${taskId}/subscribers`),
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        setSubscribers(response.data);
      } catch (error: any) {
        console.error("Error fetching subscribers:", error);
        setSubscriberError(
          error.response?.data?.message || "Failed to fetch subscribers"
        );
      }
    };

    fetchSubscribers();
  }, [taskId, token]);

  // Fetch image model configuration on component mount
  useEffect(() => {
    const fetchImageModels = async () => {
      const config = await fetchImageModelConfig();
      setImageModels(config.supportedImageModels);
      setDefaultImageModel(config.defaultImageModel);
    };

    fetchImageModels();
  }, []);

  const handleArchive = async () => {
    if (!task) return;

    try {
      if (task.status === "archived") {
        // Unarchive the task
        await axios.put(
          buildApiUrl(`/api/tasks/${taskId}`),
          { status: "active" },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        // Refresh task data and schedules
        await fetchTask();
        // Force a refresh of schedules
        handleScheduleCreated();
        setSuccess("Task unarchived successfully");
      } else {
        // Archive the task
        await axios.delete(buildApiUrl(`/api/tasks/${taskId}`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        navigate("/tasks");
      }
    } catch (error: any) {
      console.error(
        `Error ${
          task.status === "archived" ? "unarchiving" : "archiving"
        } task:`,
        error
      );
      setError(
        error.response?.data?.message ||
          `Failed to ${
            task.status === "archived" ? "unarchive" : "archive"
          } task`
      );
    }
  };

  const handleRun = async () => {
    try {
      await axios.post(
        buildApiUrl(`/api/tasks/${taskId}/execute`),
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      // Refresh executions list
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      setExecutions(response.data);
    } catch (error: any) {
      console.error("Error running task:", error);
      setError(error.response?.data?.message || "Failed to run task");
    }
  };

  const handleEmailToggle = async () => {
    if (!task) return;

    try {
      console.log("Current task:", task);

      const newEmailNotification = !task.emailNotification;
      console.log(
        "New emailNotification:",
        newEmailNotification,
        typeof newEmailNotification
      );

      const updateResponse = await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          emailNotification: newEmailNotification,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      console.log("Update response:", updateResponse.data);

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      console.log("Get task response:", taskResponse.data);
      console.log(
        "emailNotification in response:",
        taskResponse.data.emailNotification,
        typeof taskResponse.data.emailNotification
      );

      setTask(taskResponse.data);
    } catch (error: any) {
      console.error("Error updating email notification:", error);
      setError(
        error.response?.data?.message || "Failed to update email notification"
      );
    }
  };

  const handleInteractiveModeToggle = async () => {
    if (!task) return;

    try {
      const newIsInteractive = !task.isInteractive;

      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          isInteractive: newIsInteractive,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      setTask(taskResponse.data);
    } catch (error: any) {
      console.error("Error updating interactive mode:", error);
      setError(
        error.response?.data?.message || "Failed to update interactive mode"
      );
    }
  };

  // const handleDeepResearchToggle = async () => {
  //   if (!task) return;

  //   try {
  //     const newIsDeepResearch = !task.isDeepResearch;

  //     // If enabling deep research, also enable email notifications
  //     // and disable interactive mode and complex task
  //     const updateData: any = {
  //       isDeepResearch: newIsDeepResearch,
  //     };

  //     // If enabling deep research, also enable email notifications
  //     if (newIsDeepResearch) {
  //       // Enable email notifications if not already enabled
  //       if (!task.emailNotification) {
  //         updateData.emailNotification = true;
  //       }

  //       // Disable interactive mode, complex task, extract page content, and validate output
  //       updateData.isInteractive = false;
  //       updateData.isComplexTask = false;
  //       updateData.extractPageContent = false;
  //       updateData.validateOutput = false;
  //       updateData.outputAsJson = false;
  //     }

  //     // Reset LLM selection when toggling deep research mode
  //     // This ensures the appropriate LLM list will be used
  //     updateData.llmName = null;

  //     await axios.put(buildApiUrl(`/api/tasks/${taskId}`), updateData, {
  //       headers: { Authorization: `Bearer ${token}` },
  //     });

  //     // Update the task state with the response
  //     const taskResponse = await axios.get(
  //       buildApiUrl(`/api/tasks/${taskId}`),
  //       {
  //         headers: { Authorization: `Bearer ${token}` },
  //       }
  //     );

  //     setTask(taskResponse.data);
  //   } catch (error: any) {
  //     console.error("Error updating deep research mode:", error);
  //     setError(
  //       error.response?.data?.message || "Failed to update deep research mode"
  //     );
  //   }
  // };

  const handleComplexTaskToggle = async () => {
    if (!task) return;

    try {
      const newIsComplexTask = !task.isComplexTask;

      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          isComplexTask: newIsComplexTask,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      setTask(taskResponse.data);
    } catch (error: any) {
      console.error("Error updating complex task mode:", error);
      setError(
        error.response?.data?.message || "Failed to update complex task mode"
      );
    }
  };

  const handleExtractPageContentToggle = async () => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { extractPageContent: !task?.extractPageContent },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update the task state with the response from the server
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      setTask(taskResponse.data);
    } catch (error) {
      console.error("Error updating task:", error);
    }
  };

  const handleValidateOutputToggle = async () => {
    try {
      console.log(
        "Toggling validateOutput from",
        task?.validateOutput,
        "to",
        !task?.validateOutput
      );

      const response = await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { validateOutput: !task?.validateOutput },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      console.log("Validate output toggle response:", response.data);

      // Update the task state with the response from the server
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      console.log("Get task after toggle:", taskResponse.data);
      console.log(
        "validateOutput in response:",
        taskResponse.data.validateOutput
      );

      setTask(taskResponse.data);
    } catch (error) {
      console.error("Error updating validateOutput setting:", error);
      setError("Failed to update Validate Output setting");
    }
  };

  const handleFeedbackChange = async (
    executionId: string,
    feedback: "accepted" | "rejected" | null
  ) => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
        { feedback },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // Refresh executions list
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      setExecutions(response.data);
    } catch (error: any) {
      console.error("Error updating feedback:", error);
      setError(error.response?.data?.message || "Failed to update feedback");
    }
  };

  const getLatestExecution = () => {
    if (executions.length === 0) return null;
    const nonArchivedExecutions = executions.filter(
      (execution) => !execution.archived
    );
    if (nonArchivedExecutions.length === 0) return null;
    return nonArchivedExecutions.reduce((latest, current) => {
      return new Date(current.startTime) > new Date(latest.startTime)
        ? current
        : latest;
    });
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "completed":
        return "success";
      case "failed":
        return "error";
      case "running":
        return "info";
      case "pending":
        return "warning";
      case "active":
        return "success";
      case "archived":
        return "default";
      default:
        return "default";
    }
  };

  const handleScheduleCreated = async () => {
    console.log("Schedule created, refreshing data");
    await fetchTask();
    // Force a re-render of the ScheduleList component
    setScheduleRefreshTrigger((prev) => prev + 1);
  };

  const handleAddSubscriber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubscriberEmail.trim()) return;

    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/${taskId}/subscribers`),
        { email: newSubscriberEmail },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Ensure the subscriber object has all required fields
      const newSubscriber: Subscriber = {
        email: response.data.email,
        subscribedAt: response.data.subscribedAt || new Date().toISOString(),
      };

      setSubscribers([...subscribers, newSubscriber]);
      setNewSubscriberEmail("");
      setSubscriberError("");
    } catch (error: any) {
      console.error("Error adding subscriber:", error);
      // Use the server's error message if available, otherwise show a generic message
      const errorMessage =
        error.response?.data?.message ||
        (error.response?.status === 400
          ? "Invalid email address"
          : "Failed to add subscriber");
      setSubscriberError(errorMessage);
      // Don't clear the email input if there was an error
    }
  };

  const handleRemoveSubscriber = async (email: string) => {
    try {
      await axios.delete(
        buildApiUrl(
          `/api/tasks/${taskId}/subscribers/${encodeURIComponent(email)}`
        ),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSubscribers(subscribers.filter((s) => s.email !== email));
      setSubscriberError("");
    } catch (error: any) {
      console.error("Error removing subscriber:", error);
      setSubscriberError(
        error.response?.data?.message || "Failed to remove subscriber"
      );
    }
  };

  const handlePromptEdit = async () => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { prompt: editedPrompt },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Refresh task data
      const updatedTask = await fetchTask();
      if (updatedTask) {
        setTask(updatedTask);
      }
      setIsEditingPrompt(false);
    } catch (error: any) {
      console.error("Error updating prompt:", error);
      setError(error.response?.data?.message || "Failed to update prompt");
    }
  };

  const startEditing = () => {
    if (task) {
      setEditedPrompt(task.prompt);
      setIsEditingPrompt(true);
    }
  };

  const cancelEditing = () => {
    setIsEditingPrompt(false);
    setEditedPrompt("");
  };

  const handleNameEdit = async () => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { name: editedName },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Refresh task data
      const updatedTask = await fetchTask();
      if (updatedTask) {
        setTask(updatedTask);
      }
      setIsEditingName(false);
    } catch (error: any) {
      console.error("Error updating name:", error);
      setError(error.response?.data?.message || "Failed to update name");
    }
  };

  const startEditingName = () => {
    if (task) {
      setEditedName(task.name);
      setIsEditingName(true);
    }
  };

  const cancelEditingName = () => {
    setIsEditingName(false);
    setEditedName("");
  };

  const handleUserResponse = async (
    executionId: string,
    interactionId: string,
    userResponse: string
  ) => {
    try {
      await axios.put(
        buildApiUrl(
          `/api/tasks/${taskId}/executions/${executionId}/interactions/${interactionId}`
        ),
        { response: userResponse },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // Refresh executions list
      const executionsResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      setExecutions(executionsResponse.data);
    } catch (error: any) {
      console.error("Error responding to interaction:", error);
      throw error;
    }
  };

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
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
      await fetchTask(); // Refresh task to get updated attachments
    } catch (error: any) {
      if (error.response?.status === 413) {
        setUploadError(`File size too large. Maximum file size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`);
      } else {
        setUploadError(
          error.response?.data?.error || "Failed to upload file(s)"
        );
      }
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
      await fetchTask(); // Refresh task to get updated attachments
    } catch (error: any) {
      console.error("Failed to delete attachment:", error);
    }
  };

  const handleLLMChange = async (newLLMName: string) => {
    if (!task) return;

    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          llmName: newLLMName || null, // Send null to clear the preference
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      setTask(taskResponse.data);
    } catch (error: any) {
      console.error("Error updating LLM preference:", error);
      setError(
        error.response?.data?.message || "Failed to update LLM preference"
      );
    }
  };

  const handleOwnerChange = async () => {
    if (!newOwnerEmail.trim()) {
      setOwnerChangeError("Please enter an email address");
      return;
    }

    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/owner`),
        { newOwnerEmail: newOwnerEmail.trim() },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setOwnerChangeSuccess("Task ownership updated successfully");
      setNewOwnerEmail("");
      setOwnerChangeDialogOpen(false);
      await fetchTask(); // Refresh task data
    } catch (error: any) {
      console.error("Error changing task owner:", error);
      setOwnerChangeError(
        error.response?.data?.message || "Failed to change task owner"
      );
    }
  };

  // Add JSON output toggle handler
  const handleJsonOutputToggle = async () => {
    if (!task) return;

    try {
      const newOutputAsJson = !task.outputAsJson;
      const updates: any = { outputAsJson: newOutputAsJson };
      // If turning JSON on, turn HTML off
      if (newOutputAsJson && task.outputAsHtml) {
        updates.outputAsHtml = false;
      }

      await axios.put(buildApiUrl(`/api/tasks/${taskId}`), updates, {
        headers: { Authorization: `Bearer ${token}` },
      });

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setTask(taskResponse.data);
    } catch (error: any) {
      console.error("Error updating JSON output mode:", error);
      setError(
        error.response?.data?.message || "Failed to update JSON output mode"
      );
    }
  };

  const handleOutputAsHtmlToggle = async () => {
    if (!task) return;

    const newOutputAsHtml = !task.outputAsHtml;

    if (newOutputAsHtml) {
      // If enabling HTML, show popup to ask about email-friendly and repair image embedding options
      setTempEmailFriendly(task?.emailFriendlyHtml || false);
      setTempRepairImageEmbedding(task?.repairImageEmbedding || false);
      setTempHtmlTemplateFilename(task?.htmlTemplateFilename || null);
      setIsEmailFriendlyDialogOpen(true);
    } else {
      // If disabling HTML, just update the toggle and disable email-friendly and repair image embedding
      try {
        const updates: any = { 
          outputAsHtml: false,
          emailFriendlyHtml: false, // Also disable email-friendly when disabling HTML
          repairImageEmbedding: false, // Also disable repair image embedding when disabling HTML
          htmlTemplateFilename: null
        };

        await axios.put(buildApiUrl(`/api/tasks/${taskId}`), updates, {
          headers: { Authorization: `Bearer ${token}` },
        });

        // Update the task state with the response
        const taskResponse = await axios.get(
          buildApiUrl(`/api/tasks/${taskId}`),
          { headers: { Authorization: `Bearer ${token}` } }
        );

        setTask(taskResponse.data);
      } catch (error: any) {
        console.error("Error updating HTML output mode:", error);
        setError(
          error.response?.data?.message || "Failed to update HTML output mode"
        );
      }
    }
  };


  // Add the Agentic Dev Mode toggle handler
  const handleAgenticDevModeToggle = async () => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { isAgenticDevMode: !task?.isAgenticDevMode },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update the task state with the response from the server
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      setTask(taskResponse.data);
    } catch (error) {
      console.error("Error updating Agentic Dev Mode setting:", error);
      setError("Failed to update Agentic Dev Mode setting");
    }
  };

  // Handler for "Use Shared Browser" toggle and dropdown
  const handleUseSharedBrowserToggle = async () => {
    if (!task || !token) return;
    const newUseSharedBrowserValue = !(task?.useSharedBrowser || false); // Calculate new value based on task state
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${task.taskId}`),
        { useSharedBrowser: newUseSharedBrowserValue },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchTask(); // Re-fetch task data to update UI from source of truth
      setError(""); // Clear previous errors
    } catch (err) {
      console.error("Failed to update useSharedBrowser mode:", err);
      setError("Failed to update shared browser setting. Please try again.");
      // No need to revert UI change as it's bound to task state which hasn't changed on backend error
      // setUseSharedBrowser(!newUseSharedBrowser);
    }
  };

  const handleTurnOffHeadlessToggle = async () => {
    if (!task || !token) return;
    const newTurnOffHeadlessValue = !(task?.turnOffHeadless || false); // Calculate new value based on task state
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${task.taskId}`),
        { turnOffHeadless: newTurnOffHeadlessValue },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchTask(); // Re-fetch task data to update UI from source of truth
      setError(""); // Clear previous errors
    } catch (err) {
      console.error("Failed to update turn off headless:", err);
      setError("Failed to update headless mode setting. Please try again.");
    }
  };

  const handleUseKnowledgeBaseToggle = async () => {
    if (!task || !token) return;
    const newUseKnowledgeBaseValue = !(task?.useKnowledgeBase || false);
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${task.taskId}`),
        { useKnowledgeBase: newUseKnowledgeBaseValue },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchTask(); // Re-fetch task data to update UI from source of truth
      setError(""); // Clear previous errors
    } catch (err) {
      console.error("Failed to update use knowledge base:", err);
      setError("Failed to update knowledge base setting. Please try again.");
    }
  };

  const handleKnowledgeBaseEdit = async () => {
    if (task) {
      try {
        // Fetch the content from the GCS URL
        const response = await axios.get(
          buildApiUrl(`/api/tasks/${taskId}/knowledge-base`),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        setEditedKnowledgeBase(response.data.content || "");
        setIsEditingKnowledgeBase(true);
      } catch (error: any) {
        console.error("Error fetching knowledge base:", error);
        setKnowledgeBaseError(
          error.response?.data?.message || "Failed to fetch knowledge base"
        );
      }
    }
  };

  const handleKnowledgeBaseCancel = () => {
    // Fetch the content again to restore it
    if (task?.knowledgeBase) {
      axios
        .get(buildApiUrl(`/api/tasks/${taskId}/knowledge-base`), {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((response) => {
          setEditedKnowledgeBase(response.data.content || "");
        })
        .catch((error) => {
          console.error("Error restoring knowledge base content:", error);
        });
    }
    setIsEditingKnowledgeBase(false);
  };

  const handleKnowledgeBaseSave = async () => {
    if (!task) return;

    try {
      const response = await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/knowledge-base`),
        { content: editedKnowledgeBase || "" }, // Allow empty string
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update task with the new knowledge base URL and content
      const updatedTask = {
        ...task,
        knowledgeBase: response.data.url,
        knowledgeBaseUpdatedAt: response.data.knowledgeBaseUpdatedAt,
      };
      setTask(updatedTask);
      // Update the edited content
      setEditedKnowledgeBase(response.data.content || "");
      setIsEditingKnowledgeBase(false);
      setKnowledgeBaseError("");
    } catch (error: any) {
      console.error("Error updating knowledge base:", error);
      setKnowledgeBaseError(
        error.response?.data?.message || "Failed to update knowledge base"
      );
    }
  };

  // Load task and knowledge base on mount
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const taskData = await fetchTask();
        if (taskData) {
          // Always try to load knowledge base content
          try {
            const response = await axios.get(
              buildApiUrl(`/api/tasks/${taskId}/knowledge-base`),
              { headers: { Authorization: `Bearer ${token}` } }
            );
            // Set the edited content
            setEditedKnowledgeBase(response.data.content || "");
            // Update task with the knowledge base URL if it's new
            const updatedTask = {
              ...taskData,
              knowledgeBase: response.data.url,
              knowledgeBaseUpdatedAt: response.data.knowledgeBaseUpdatedAt,
            };
            setTask(updatedTask);
          } catch (error: any) {
            console.error("Error loading knowledge base:", error);
            // Only show error if it's not a 404 (file doesn't exist yet)
            if (error.response?.status !== 404) {
              setKnowledgeBaseError(
                error.response?.data?.message || "Failed to load knowledge base"
              );
            }
          }
        }
      } catch (error: any) {
        console.error("Error loading task:", error);
        setError(error.response?.data?.message || "Failed to load task");
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [taskId, token]);

  // Add function to handle knowledge base update
  const handleUpdateKnowledgeBase = async (executionId: string) => {
    if (!task) return;

    try {
      setIsUpdatingKnowledgeBase(executionId);
      const response = await axios.post(
        buildApiUrl(
          `/api/tasks/${taskId}/executions/${executionId}/update-knowledge-base`
        ),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update the knowledge base content
      setEditedKnowledgeBase(response.data.content);

      // Refresh executions list to get updated knowledge_base_updated_at
      const executionsResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      setExecutions(executionsResponse.data);

      setIsUpdatingKnowledgeBase(null);

      // Show success message
      toast.success("Knowledge base updated successfully");
    } catch (error: any) {
      console.error("Error updating knowledge base:", error);
      toast.error(
        error.response?.data?.message || "Failed to update knowledge base"
      );
      setIsUpdatingKnowledgeBase(null);
    }
  };

  const handleKnowledgeBaseTypeToggle = async () => {
    if (!task || !token) return;
    const newKnowledgeBaseType =
      task.knowledgeBaseType === "public" ? "private" : "public";
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${task.taskId}/knowledge-base-type`),
        { knowledgeBaseType: newKnowledgeBaseType },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchTask(); // Re-fetch task data to update UI from source of truth
      setError(""); // Clear previous errors
    } catch (err) {
      console.error("Failed to update knowledge base type:", err);
      setError("Failed to update knowledge base type. Please try again.");
    }
  };

  // Add the handler function after handleUseKnowledgeBaseToggle
  const handleUpdateKnowledgeBaseToggle = async () => {
    if (!task || !token) return;
    const newUpdateKnowledgeBaseValue = !(task?.updateKnowledgeBase || false);
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${task.taskId}`),
        { updateKnowledgeBase: newUpdateKnowledgeBaseValue },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchTask(); // Re-fetch task data to update UI from source of truth
      setError(""); // Clear previous errors
    } catch (err) {
      console.error("Failed to update knowledge base update setting:", err);
      setError(
        "Failed to update knowledge base update setting. Please try again."
      );
    }
  };

  // Add the handler function after handleUpdateKnowledgeBaseToggle
  const handleUpdateLeadListToggle = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const newValue = event.target.checked;

    if (newValue) {
      // If enabling and no identifier exists, open the dialog
      if (!task?.leadListIdentifier) {
        setIsLeadListDialogOpen(true);
      } else {
        // If identifier exists, just update the toggle
        try {
          await axios.put(
            buildApiUrl(`/api/tasks/${taskId}`),
            {
              updateLeadList: true,
            },
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          await fetchTask();
        } catch (error) {
          console.error("Error updating lead list settings:", error);
          toast.error("Failed to update lead list settings");
        }
      }
    } else {
      // If disabling, just update the toggle
      try {
        await axios.put(
          buildApiUrl(`/api/tasks/${taskId}`),
          {
            updateLeadList: false,
          },
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        await fetchTask();
      } catch (error) {
        console.error("Error updating lead list settings:", error);
        toast.error("Failed to update lead list settings");
      }
    }
  };

  // Add validation function
  const validateLeadListIdentifier = (value: string) => {
    if (!value) {
      return "Identifier is required";
    }
    if (!/^[a-z_]+$/.test(value)) {
      return "Identifier must be lowercase and can only contain letters and underscores";
    }
    return "";
  };

  // Add handler for the dialog
  const handleLeadListDialogClose = () => {
    setIsLeadListDialogOpen(false);
    setLeadListIdentifier("");
    setLeadListIdentifierError("");
  };

  const handleEmailFriendlyDialogClose = () => {
    setIsEmailFriendlyDialogOpen(false);
  };

  const handleEmailFriendlyDialogConfirm = async () => {
    try {
      const updates: any = { 
        outputAsHtml: true,
        emailFriendlyHtml: tempEmailFriendly,
        repairImageEmbedding: tempRepairImageEmbedding
      };
      if (tempHtmlTemplateFilename) {
        updates.htmlTemplateFilename = tempHtmlTemplateFilename;
      }
      
      // If enabling email-friendly, turn JSON off
      if (tempEmailFriendly && task?.outputAsJson) {
        updates.outputAsJson = false;
      }
      
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        updates,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      await fetchTask();
      handleEmailFriendlyDialogClose();
    } catch (error) {
      console.error("Error updating HTML output settings:", error);
      toast.error("Failed to update HTML output settings");
    }
  };


  const handleLeadListDialogConfirm = async () => {
    const error = validateLeadListIdentifier(leadListIdentifier);
    if (error) {
      setLeadListIdentifierError(error);
      return;
    }

    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          updateLeadList: true,
          leadListIdentifier: leadListIdentifier,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      await fetchTask();
      handleLeadListDialogClose();
    } catch (error) {
      console.error("Error updating lead list settings:", error);
      toast.error("Failed to update lead list settings");
    }
  };

  // Add video model dialog handlers
  const handleVideoModelDialogClose = () => {
    setIsVideoModelDialogOpen(false);
    setSelectedVideoModel("");
  };

  const handleVideoModelDialogConfirm = async () => {
    if (!selectedVideoModel.trim()) {
      return;
    }

    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          createVideo: true,
          videoModel: selectedVideoModel,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      await fetchTask();
    } catch (error) {
      console.error("Error updating video model settings:", error);
      setError("Failed to update video model settings");
    } finally {
      // Always close the dialog regardless of success or failure
      handleVideoModelDialogClose();
    }
  };





  const handleCreateVideoToggle = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const newValue = event.target.checked;

    if (newValue) {
      // If enabling and no video model exists, open the dialog
      if (!task?.videoModel) {
        setIsVideoModelDialogOpen(true);
      } else {
        // If video model exists, just update the toggle
        try {
          await axios.put(
            buildApiUrl(`/api/tasks/${taskId}`),
            {
              createVideo: true,
            },
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          await fetchTask();
        } catch (error) {
          console.error("Error updating create video settings:", error);
          toast.error("Failed to update create video settings");
        }
      }
    } else {
      // If disabling, just update the toggle
      try {
        await axios.put(
          buildApiUrl(`/api/tasks/${taskId}`),
          {
            createVideo: false,
          },
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        await fetchTask();
      } catch (error) {
        console.error("Error updating create video settings:", error);
        toast.error("Failed to update create video settings");
      }
    }
  };

  if (loading) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        minHeight="60vh"
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Container maxWidth="md">
        <Alert severity="error" sx={{ mt: 4 }}>
          {error}
        </Alert>
      </Container>
    );
  }

  if (!task) {
    return (
      <Container maxWidth="md">
        <Alert severity="info" sx={{ mt: 4 }}>
          Task not found
        </Alert>
      </Container>
    );
  }

  if (!taskId) {
    return (
      <Container maxWidth="md">
        <Alert severity="error" sx={{ mt: 4 }}>
          No task ID provided
        </Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Paper sx={{ p: 4, mt: 4 }}>
        {/* Admin viewing indicator */}
        {user?.isAdmin && user?.userId !== task.userId && (
          <Alert severity="info" sx={{ mb: 3 }}>
            You are viewing another user's task as an administrator.
          </Alert>
        )}

        {/* Task header with owner change button */}
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            mb: 3,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            {isEditingName ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <TextField
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  variant="outlined"
                  size="small"
                  autoFocus
                  sx={{ minWidth: "300px" }}
                />
                <IconButton
                  onClick={handleNameEdit}
                  size="small"
                  color="primary"
                  disabled={!editedName.trim() || editedName === task?.name}
                >
                  <SaveIcon />
                </IconButton>
                <IconButton onClick={cancelEditingName} size="small">
                  <CancelIcon />
                </IconButton>
              </Box>
            ) : (
              <>
                <Typography variant="h4" component="h1">
                  {task.name}
                </Typography>
                {showActions && (
                  <Tooltip title="Edit name">
                    <IconButton onClick={startEditingName} size="small">
                      <EditIcon />
                    </IconButton>
                  </Tooltip>
                )}
                {user?.isAdmin && (
                  <Tooltip title="Change Owner">
                    <IconButton
                      color="primary"
                      onClick={() => setOwnerChangeDialogOpen(true)}
                      size="small"
                    >
                      <PersonAddIcon />
                    </IconButton>
                  </Tooltip>
                )}
              </>
            )}
          </Box>
        </Box>

        {/* Change Owner Dialog */}
        <Dialog
          open={ownerChangeDialogOpen}
          onClose={() => {
            setOwnerChangeDialogOpen(false);
            setOwnerChangeError("");
            setOwnerChangeSuccess("");
          }}
        >
          <DialogTitle>Change Task Owner</DialogTitle>
          <DialogContent>
            <Box sx={{ pt: 2 }}>
              <TextField
                label="New Owner Email"
                variant="outlined"
                fullWidth
                value={newOwnerEmail}
                onChange={(e) => setNewOwnerEmail(e.target.value)}
                error={!!ownerChangeError}
                helperText={ownerChangeError}
                type="email"
                placeholder="Enter new owner's email address"
              />
              {ownerChangeSuccess && (
                <Alert severity="success" sx={{ mt: 2 }}>
                  {ownerChangeSuccess}
                </Alert>
              )}
            </Box>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => {
                setOwnerChangeDialogOpen(false);
                setOwnerChangeError("");
                setOwnerChangeSuccess("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="primary"
              onClick={handleOwnerChange}
              disabled={!newOwnerEmail.trim()}
            >
              Change Owner
            </Button>
          </DialogActions>
        </Dialog>

        <Box
          sx={{
            mb: 4,
            display: "flex",
            flexDirection: { xs: "column", md: "row" },
            justifyContent: "space-between",
            alignItems: { xs: "stretch", md: "flex-start" },
            gap: 2,
          }}
        >
          <Box sx={{ flex: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
              <Chip
                label={`Task: ${task.status}`}
                color={getStatusColor(task.status)}
              />
              {getLatestExecution() && (
                <Chip
                  label={`Latest Run: ${getLatestExecution()?.status}`}
                  color={getStatusColor(getLatestExecution()?.status || "")}
                />
              )}
            </Box>
            {/* Only show Owner if the current user is not the owner */}
            {user?.userId !== task.userId && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Owner:{" "}
                {user?.isAdmin ? (
                  <RouterLink
                    to={`/profile/${task.userId}`}
                    style={{ textDecoration: "none" }}
                  >
                    {task.userId}
                  </RouterLink>
                ) : (
                  task.userId
                )}
              </Typography>
            )}
            {showActions && (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: {
                      xs: "1fr",
                      sm: "repeat(2, 1fr)",
                    },
                    gap: 1,
                    mb: 2,
                  }}
                >
                  <FormControlLabel
                    control={
                      <Switch
                        checked={Boolean(task.emailNotification)}
                        onChange={handleEmailToggle}
                        color="primary"
                      />
                    }
                    label="Email Me Latest Run"
                  />
                  <Tooltip title="When enabled, the agent can pause execution to request additional information from you">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.isInteractive)}
                          onChange={handleInteractiveModeToggle}
                          color="primary"
                          disabled={Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Interactive Mode"
                      sx={{ opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  {/* <Tooltip title="When enabled, the task will use advanced AI to perform comprehensive research on your topic using public web data only. Currently does not use your uploads or web accounts (Config), but will support these in the future.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.isDeepResearch)}
                          onChange={handleDeepResearchToggle}
                          color="primary"
                        />
                      }
                      label="Perform Deep Research"
                    />
                  </Tooltip> */}
                  <Tooltip title="When enabled, the task will allow the agent to take up to 100 steps (instead of the default 25) to complete complex tasks that require more actions">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.isComplexTask)}
                          onChange={handleComplexTaskToggle}
                          color="primary"
                          disabled={Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Complex Task"
                      sx={{ opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will extract structured content from web pages and save it as JSON files">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.extractPageContent || false}
                          onChange={handleExtractPageContentToggle}
                          disabled={loading || Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Extract Page Content"
                      sx={{
                        mt: 1,
                        opacity: Boolean(task.isDeepResearch) ? 0.5 : 1,
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will validate its output to ensure accuracy">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.validateOutput || false}
                          onChange={handleValidateOutputToggle}
                          disabled={loading || Boolean(task.isDeepResearch)}
                          color="primary"
                        />
                      }
                      label="Validate Output"
                      sx={{
                        mt: 1,
                        opacity: Boolean(task.isDeepResearch) ? 0.5 : 1,
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will output its final result in JSON format. This is useful for structured data extraction.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.outputAsJson)}
                          onChange={handleJsonOutputToggle}
                          color="primary"
                          disabled={Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Output as JSON"
                      sx={{ opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will output its final result in HTML5 format. This is useful for rich text or formatted content.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.outputAsHtml)}
                          onChange={handleOutputAsHtmlToggle}
                          color="primary"
                          disabled={Boolean(task.isDeepResearch)}
                        />
                      }
                      label={
                        <Box
                          component="span"
                          sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}
                        >
                          <Typography>Output as HTML5</Typography>
                          {task?.htmlTemplateFilename && (
                            <Chip
                              label={`Template: ${task.htmlTemplateFilename}`}
                              size="small"
                              color="default"
                              variant="outlined"
                            />
                          )}
                          {task?.emailFriendlyHtml && (
                            <Chip
                              label="Email Friendly"
                              size="small"
                              color="primary"
                              variant="outlined"
                            />
                          )}
                          {task?.repairImageEmbedding && (
                            <Chip
                              label="Repair Image Embedding"
                              size="small"
                              color="secondary"
                              variant="outlined"
                            />
                          )}
                        </Box>
                      }
                      sx={{ opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent can access the current page's content and run JavaScript on the page, providing more developer-oriented capabilities.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.isAgenticDevMode || false}
                          onChange={handleAgenticDevModeToggle}
                          disabled={loading || Boolean(task.isDeepResearch)}
                          color="primary"
                        />
                      }
                      label="Agentic Dev Mode"
                      sx={{
                        mt: 1,
                        opacity: Boolean(task.isDeepResearch) ? 0.5 : 1,
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="Enable to use a shared browser session for this task. This will use the website configs shared publicly.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.useSharedBrowser || false}
                          onChange={handleUseSharedBrowserToggle}
                        />
                      }
                      label="Use Shared Browser"
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the browser will not be headless during task execution. This is needed for accessing some websites that require a visible browser such as x.com, circle.so, etc.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.turnOffHeadless || false}
                          onChange={handleTurnOffHeadlessToggle}
                        />
                      }
                      label="Turn Off Headless"
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent can search the knowledge base for relevant information during task execution">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.useKnowledgeBase || false}
                          onChange={handleUseKnowledgeBaseToggle}
                        />
                      }
                      label="Use Knowledge Base"
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will update the knowledge base with new information after each successful task execution">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.updateKnowledgeBase || false}
                          onChange={handleUpdateKnowledgeBaseToggle}
                        />
                      }
                      label="Update Knowledge Base"
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will update the lead list with new information after each successful task execution">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.updateLeadList || false}
                          onChange={handleUpdateLeadListToggle}
                          color="primary"
                        />
                      }
                      label={
                        <Box
                          sx={{ display: "flex", alignItems: "center", gap: 1 }}
                        >
                          <Typography>Update Lead List</Typography>
                          {task?.updateLeadList && task?.leadListIdentifier && (
                            <Chip
                              label={`Identifier: ${task.leadListIdentifier}`}
                              size="small"
                              color="primary"
                              variant="outlined"
                            />
                          )}
                        </Box>
                      }
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will create a video recording of the task execution for review and documentation">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.createVideo || false}
                          onChange={handleCreateVideoToggle}
                        />
                      }
                      label={
                        <Box
                          sx={{ display: "flex", alignItems: "center", gap: 1 }}
                        >
                          <Typography>Create Video</Typography>
                          {task?.createVideo && task?.videoModel && (
                            <Chip
                              label={`Model: ${task.videoModel}`}
                              size="small"
                              color="primary"
                              variant="outlined"
                            />
                          )}
                        </Box>
                      }
                    />
                  </Tooltip>
                          <Tooltip title="Select the image model to use for image generation tasks" placement="right">
          <FormControl sx={{ width: "100%" }}>
            <InputLabel id="image-model-select-label">Image Model</InputLabel>
            <Select
              labelId="image-model-select-label"
              value={getEffectiveImageModel(task?.imageModel, defaultImageModel)}
              onChange={(e) => {
                const newModel = e.target.value;
                console.log('Image model selection changed:', {
                  newModel,
                  currentModel: task?.imageModel,
                  defaultModel: defaultImageModel,
                  effectiveModel: getEffectiveImageModel(task?.imageModel, defaultImageModel),
                  taskId
                });
                // Always update to ensure the selection is saved in the database
                axios.put(
                  buildApiUrl(`/api/tasks/${taskId}`),
                  {
                    imageModel: newModel,
                  },
                  {
                    headers: { Authorization: `Bearer ${token}` },
                  }
                ).then(() => {
                  console.log('Image model updated successfully, fetching task...');
                  return fetchTask();
                }).catch((error) => {
                  console.error("Error updating image model:", error);
                  toast.error("Failed to update image model");
                });
              }}
              label="Image Model"
            >
              {imageModels.map((model) => (
                <MenuItem key={model.value} value={model.value}>
                  <Box>
                    <Typography>
                      {model.label}
                      {model.value === defaultImageModel && !task?.imageModel && (
                        <Chip label="Default" size="small" color="primary" sx={{ ml: 1 }} />
                      )}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {model.description}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Tooltip>
                </Box>
                <Tooltip
                  title={
                    <div>
                      <p>
                        If selected, this LLM will be used first to run the
                        task. If it fails, other LLMs will be tried as backup.
                      </p>
                      <p>
                        LLM format:{" "}
                        {`<deployment>${">"}<provider>${">"}<version>`}
                      </p>
                      <p>
                        Example: "azure-{">"}-openai-{">"}-gpt-4o" means GPT-4
                        model deployed on Azure, provided by OpenAI
                      </p>
                    </div>
                  }
                  placement="right"
                >
                  <FormControl sx={{ width: "100%" }}>
                    <InputLabel id="llm-select-label">Preferred LLM</InputLabel>
                    <Select
                      labelId="llm-select-label"
                      value={task.llmName || ""}
                      onChange={(e) => handleLLMChange(e.target.value)}
                      label="Preferred LLM"
                    >
                      <MenuItem value="">
                        <em>System Default Order</em>
                      </MenuItem>
                      {(task &&
                      task.selectedLLMs &&
                      task.selectedLLMs.length > 0
                        ? task.selectedLLMs
                        : getLLMsForTask(Boolean(task?.isDeepResearch))
                      ).map((llm: string) => (
                        <MenuItem key={llm} value={llm}>
                          {llm}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Tooltip>
              </Box>
            )}
          </Box>
          {showActions && (
            <Box
              sx={{
                display: "flex",
                gap: 2,
                flexShrink: 0,
                justifyContent: { xs: "flex-start", md: "flex-end" },
                mt: { xs: 2, md: 0 },
              }}
            >
              <Button
                variant="contained"
                color="primary"
                onClick={handleRun}
                disabled={
                  getLatestExecution()?.status === "running" ||
                  task?.status === "archived"
                }
              >
                Run Task
              </Button>
              <Button
                variant="outlined"
                color={task?.status === "archived" ? "info" : "warning"}
                onClick={handleArchive}
                startIcon={
                  task?.status === "archived" ? (
                    <UnarchiveIcon />
                  ) : (
                    <ArchiveIcon />
                  )
                }
              >
                {task?.status === "archived"
                  ? "Unarchive Task"
                  : "Archive Task"}
              </Button>
            </Box>
          )}
        </Box>

        {/* {task.isDeepResearch && (
          <Alert severity="info" sx={{ mt: 1, mb: 3 }}>
            Deep Research Mode is enabled. When you run this task, it will use advanced AI to perform comprehensive research on your topic using public web data only. Currently does not use your uploads or web accounts (Config), but will support these in the future. Email notifications are automatically enabled for Deep Research tasks.
          </Alert>
        )} */}

        <Grid container spacing={3}>
          <Grid item xs={12}>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                mb: 2,
              }}
            >
              <Typography variant="h6" gutterBottom>
                Task Prompt
              </Typography>
              {showActions && !isEditingPrompt && (
                <Tooltip title="Edit prompt">
                  <IconButton onClick={startEditing} size="small">
                    <EditIcon />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
            {isEditingPrompt ? (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <TextField
                  multiline
                  rows={4}
                  fullWidth
                  value={editedPrompt}
                  onChange={(e) => setEditedPrompt(e.target.value)}
                  variant="outlined"
                />
                <Box
                  sx={{ display: "flex", gap: 1, justifyContent: "flex-end" }}
                >
                  <Button
                    startIcon={<CancelIcon />}
                    onClick={cancelEditing}
                    variant="outlined"
                    color="inherit"
                  >
                    Cancel
                  </Button>
                  <Button
                    startIcon={<SaveIcon />}
                    onClick={handlePromptEdit}
                    variant="contained"
                    color="primary"
                    disabled={
                      !editedPrompt.trim() || editedPrompt === task?.prompt
                    }
                  >
                    Save
                  </Button>
                </Box>
              </Box>
            ) : (
              <Typography variant="body1" paragraph>
                {task.prompt}
              </Typography>
            )}
          </Grid>

          {/* Attachments Section */}
          <Grid item xs={12}>
            <Typography variant="h6" gutterBottom>
              Attachments
            </Typography>

            <Box sx={{ mb: 2 }}>
              <input
                accept="*/*"
                style={{ display: "none" }}
                id="file-upload"
                type="file"
                onChange={handleFileUpload}
                multiple
              />
              <label htmlFor="file-upload">
                <Button
                  variant="contained"
                  component="span"
                  disabled={
                    isUploading || (task?.attachments?.length || 0) >= 5
                  }
                  startIcon={
                    isUploading ? <CircularProgress size={20} /> : undefined
                  }
                >
                  {isUploading ? "Uploading..." : "Upload Files"}
                </Button>
              </label>
              {(task?.attachments?.length || 0) >= 5 && (
                <Typography
                  color="error"
                  variant="caption"
                  sx={{ display: "block", mt: 1 }}
                >
                  Maximum number of attachments (5) reached
                </Typography>
              )}
              {uploadError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {uploadError}
                </Alert>
              )}
            </Box>

            <List>
              {task?.attachments?.map((attachment) => (
                <ListItem
                  key={attachment.key}
                  secondaryAction={
                    <IconButton
                      edge="end"
                      aria-label="delete"
                      onClick={() => handleDeleteAttachment(attachment.key)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  }
                >
                  <ListItemText
                    primary={
                      <Link
                        href={attachment.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {attachment.filename}
                      </Link>
                    }
                    secondary={new Date(attachment.uploadedAt).toLocaleString()}
                  />
                </ListItem>
              ))}
              {(!task?.attachments || task.attachments.length === 0) && (
                <Typography color="textSecondary">
                  No attachments yet
                </Typography>
              )}
            </List>
          </Grid>

          {task.summary && (
            <Grid item xs={12}>
              <Typography variant="h6" gutterBottom>
                Latest Summary
              </Typography>
              <Typography variant="body1" paragraph>
                {task.summary}
              </Typography>
            </Grid>
          )}

          {task.error && (
            <Grid item xs={12}>
              <Typography variant="h6" gutterBottom color="error">
                Error
              </Typography>
              <Typography variant="body1" color="error" paragraph>
                {task.error}
              </Typography>
            </Grid>
          )}

          {/* Lead List Section */}
          <Grid item xs={12}>
            <LeadListSection
              taskId={taskId}
              updateLeadList={task.updateLeadList || false}
              leadListIdentifier={task.leadListIdentifier || ""}
            />
          </Grid>

          {/* Knowledge Base Section */}
          <Grid item xs={12}>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                mb: 2,
              }}
            >
              <Box>
                <Typography variant="h6" gutterBottom>
                  Knowledge Base{" "}
                  {task.knowledgeBaseType &&
                    `(${
                      task.knowledgeBaseType.charAt(0).toUpperCase() +
                      task.knowledgeBaseType.slice(1)
                    })`}
                </Typography>
                {task.knowledgeBaseUpdatedAt && (
                  <Typography variant="caption" color="textSecondary">
                    Last updated:{" "}
                    {new Date(task.knowledgeBaseUpdatedAt).toLocaleString()}
                  </Typography>
                )}
              </Box>
              {showActions && !isEditingKnowledgeBase && (
                <Box sx={{ display: "flex", gap: 1 }}>
                  <Tooltip
                    title={
                      task.knowledgeBaseType === "public"
                        ? "The knowledge base is currently public (accessible to all accounts on AgentWeb). Click to make it private (only accessible to this account)."
                        : "The knowledge base is currently private (only accessible to this account). Click to make it public (accessible to all accounts on AgentWeb)."
                    }
                  >
                    <IconButton
                      size="small"
                      onClick={handleKnowledgeBaseTypeToggle}
                      disabled={false}
                    >
                      {task.knowledgeBaseType === "public" ? (
                        <LockOpenIcon />
                      ) : (
                        <LockIcon />
                      )}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit knowledge base">
                    <IconButton onClick={handleKnowledgeBaseEdit} size="small">
                      <EditIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}
            </Box>
            {knowledgeBaseError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {knowledgeBaseError}
              </Alert>
            )}
            {isEditingKnowledgeBase ? (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <TextField
                  multiline
                  rows={10}
                  fullWidth
                  value={editedKnowledgeBase}
                  onChange={(e) => setEditedKnowledgeBase(e.target.value)}
                  variant="outlined"
                  placeholder="Enter knowledge base content..."
                />
                <Box
                  sx={{ display: "flex", gap: 1, justifyContent: "flex-end" }}
                >
                  <Button
                    startIcon={<CancelIcon />}
                    onClick={handleKnowledgeBaseCancel}
                    variant="outlined"
                    color="inherit"
                  >
                    Cancel
                  </Button>
                  <Button
                    startIcon={<SaveIcon />}
                    onClick={handleKnowledgeBaseSave}
                    variant="contained"
                    color="primary"
                  >
                    Save
                  </Button>
                </Box>
              </Box>
            ) : (
              <Box
                sx={{
                  backgroundColor: "#f5f5f5",
                  padding: 2,
                  borderRadius: 1,
                  height: "300px",
                  overflow: "auto",
                }}
              >
                {editedKnowledgeBase ? (
                  <Typography
                    variant="body1"
                    component="pre"
                    sx={{
                      whiteSpace: "pre-wrap",
                      fontFamily: "monospace",
                      margin: 0,
                    }}
                  >
                    {editedKnowledgeBase}
                  </Typography>
                ) : (
                  <Typography
                    variant="body1"
                    component="pre"
                    sx={{
                      whiteSpace: "pre-wrap",
                      fontFamily: "monospace",
                      margin: 0,
                    }}
                  >
                    No knowledge base content yet. Click the edit button to add
                    content.
                  </Typography>
                )}
              </Box>
            )}
          </Grid>

          <Grid item xs={12}>
            <Typography variant="h6" gutterBottom sx={{ mt: 2 }}>
              Execution History
            </Typography>
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell width="100px">Status</TableCell>
                    <TableCell width="150px">Started</TableCell>
                    <TableCell width="150px">Completed</TableCell>
                    <TableCell width="25%">Prompt</TableCell>
                    <TableCell width="25%">Result</TableCell>
                    <TableCell width="250px">Details</TableCell>
                    <TableCell width="80px" align="center">
                      Feedback
                    </TableCell>
                    <TableCell width="100px" align="center">
                      Actions
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {executions
                    .filter((execution) => !execution.archived)
                    .map((execution) => (
                      <TableRow key={execution.executionId}>
                        <TableCell>
                          <Chip
                            label={execution.status}
                            color={getStatusColor(execution.status)}
                            size="small"
                          />
                        </TableCell>
                        <TableCell>
                          {new Date(execution.startTime).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {execution.completedAt
                            ? new Date(execution.completedAt).toLocaleString()
                            : "-"}
                        </TableCell>
                        <TableCell>
                          {execution.prompt ? (
                            <CollapsibleText text={execution.prompt} />
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell>
                          {execution.status === "running" &&
                          execution.userInteractions &&
                          execution.userInteractions.length > 0 ? (
                            <Box>
                              <UserInteractionDialog
                                execution={execution}
                                onRespond={handleUserResponse}
                              />
                            </Box>
                          ) : (
                            <Box>
                              {execution.error ? (
                                <Box sx={{ color: "error.main" }}>
                                  <CollapsibleText text={execution.error} />
                                </Box>
                              ) : (
                                <CollapsibleText
                                  text={execution.result || "-"}
                                />
                              )}
                              {execution.result_files &&
                                execution.result_files.length > 0 && (
                                  <Box mt={1}>
                                    <Typography
                                      variant="subtitle2"
                                      color="textSecondary"
                                    >
                                      Result Files:
                                    </Typography>
                                    <Box display="flex" gap={1} flexWrap="wrap">
                                      {execution.result_files.map(
                                        (file, index) => (
                                          <Chip
                                            key={index}
                                            label={truncateFilename(
                                              file.filename
                                            )}
                                            component="a"
                                            href={file.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            clickable
                                            color="primary"
                                            variant="outlined"
                                            size="small"
                                            sx={{ mt: 1 }}
                                            icon={
                                              file.is_html ? (
                                                <ScreenshotIcon fontSize="small" />
                                              ) : undefined
                                            }
                                          />
                                        )
                                      )}
                                    </Box>
                                  </Box>
                                )}
                              <Box sx={{ mt: 1 }}>
                                <Link
                                  component="button"
                                  variant="body2"
                                  onClick={() =>
                                    navigate(
                                      `/tasks/${taskId}/executions/${execution.executionId}`
                                    )
                                  }
                                  sx={{ display: "block" }}
                                >
                                  View Full Details
                                </Link>
                              </Box>
                            </Box>
                          )}
                        </TableCell>
                        <TableCell>
                          {execution.details_gif ? (
                            <a
                              href={execution.details_gif}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <img
                                src={execution.details_gif}
                                alt="Execution Details"
                                style={{
                                  maxWidth: "250px",
                                  cursor: "pointer",
                                  border: "1px solid #eee",
                                  borderRadius: "4px",
                                }}
                              />
                            </a>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell align="center">
                          <Box
                            sx={{
                              display: "flex",
                              justifyContent: "center",
                              gap: 0.5,
                            }}
                          >
                            <Tooltip
                              title={
                                execution.feedback
                                  ? `Current: ${execution.feedback}`
                                  : "Set feedback"
                              }
                            >
                              <IconButton
                                size="small"
                                onClick={() =>
                                  handleFeedbackChange(
                                    execution.executionId,
                                    execution.feedback === "accepted"
                                      ? null
                                      : "accepted"
                                  )
                                }
                                color={
                                  execution.feedback === "accepted"
                                    ? "success"
                                    : "default"
                                }
                              >
                                <ThumbUpIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip
                              title={
                                execution.feedback
                                  ? `Current: ${execution.feedback}`
                                  : "Set feedback"
                              }
                            >
                              <IconButton
                                size="small"
                                onClick={() =>
                                  handleFeedbackChange(
                                    execution.executionId,
                                    execution.feedback === "rejected"
                                      ? null
                                      : "rejected"
                                  )
                                }
                                color={
                                  execution.feedback === "rejected"
                                    ? "error"
                                    : "default"
                                }
                              >
                                <ThumbDownIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Box>
                        </TableCell>
                        <TableCell align="center">
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Button
                              variant="outlined"
                              size="small"
                              onClick={() =>
                                handleUpdateKnowledgeBase(execution.executionId)
                              }
                              disabled={
                                isUpdatingKnowledgeBase ===
                                execution.executionId
                              }
                              sx={{ minWidth: "160px" }}
                            >
                              {isUpdatingKnowledgeBase ===
                              execution.executionId ? (
                                <CircularProgress size={20} />
                              ) : (
                                "Update Knowledge Base"
                              )}
                            </Button>
                            {execution.knowledge_base_updated_at && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Last updated:{" "}
                                {new Date(
                                  execution.knowledge_base_updated_at
                                ).toLocaleString()}
                              </Typography>
                            )}
                          </Box>
                        </TableCell>
                      </TableRow>
                    ))}
                  {executions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} align="center">
                        <Typography variant="body2" color="text.secondary">
                          No executions yet
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Grid>
        </Grid>

        <Box sx={{ mt: 4 }}>
          <Typography variant="h5" gutterBottom>
            Task Scheduling
          </Typography>
          <ScheduleForm
            taskId={taskId}
            onScheduleCreated={handleScheduleCreated}
          />
          <ScheduleList
            taskId={taskId}
            onScheduleUpdated={handleScheduleCreated}
            key={scheduleRefreshTrigger}
          />
        </Box>
      </Paper>

      {/* Subscriber Management Section */}
      <Paper sx={{ p: 3, mt: 3 }}>
        <Typography variant="h6" gutterBottom>
          Subscribers
        </Typography>

        <Box
          component="form"
          onSubmit={handleAddSubscriber}
          sx={{ mb: 3, display: "flex", gap: 2 }}
        >
          <TextField
            label="Email"
            variant="outlined"
            size="small"
            value={newSubscriberEmail}
            onChange={(e) => setNewSubscriberEmail(e.target.value)}
            error={!!subscriberError}
            helperText={subscriberError}
            sx={{ flexGrow: 1 }}
            type="email"
            placeholder="Enter email address"
          />
          <Button
            type="submit"
            variant="contained"
            color="primary"
            disabled={!newSubscriberEmail.trim()}
          >
            Add Subscriber
          </Button>
        </Box>

        <List>
          {subscribers.map((subscriber) => (
            <ListItem key={subscriber.email}>
              <ListItemText
                primary={subscriber.email}
                secondary={`Subscribed on ${new Date(
                  subscriber.subscribedAt
                ).toLocaleDateString()}`}
              />
              <ListItemSecondaryAction>
                <IconButton
                  edge="end"
                  aria-label="delete"
                  onClick={() => handleRemoveSubscriber(subscriber.email)}
                >
                  <DeleteIcon />
                </IconButton>
              </ListItemSecondaryAction>
            </ListItem>
          ))}
        </List>

        {subscribers.length === 0 && (
          <Typography color="textSecondary" align="center">
            No subscribers yet
          </Typography>
        )}
      </Paper>

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

      {/* Lead List Dialog */}
      <Dialog
        open={isLeadListDialogOpen}
        onClose={handleLeadListDialogClose}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Configure Lead List Identifier</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Enter a unique identifier for deduplication and lookup purposes. It
            must be lowercase and can only contain letters and underscores
            (e.g., email, full-name, etc.).
            <Box
              component="span"
              sx={{ color: "warning.main", display: "block", mt: 1 }}
            >
              ⚠️ Warning: The identifier cannot be changed after it is set.
            </Box>
          </DialogContentText>
          <TextField
            autoFocus
            margin="dense"
            label="Identifier"
            type="text"
            fullWidth
            variant="outlined"
            value={leadListIdentifier}
            onChange={(e) => {
              setLeadListIdentifier(e.target.value.toLowerCase());
              setLeadListIdentifierError("");
            }}
            error={!!leadListIdentifierError}
            helperText={leadListIdentifierError}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleLeadListDialogClose}>Cancel</Button>
          <Button
            onClick={handleLeadListDialogConfirm}
            variant="contained"
            color="primary"
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>

      {/* Video Model Dialog */}
      <Dialog
        open={isVideoModelDialogOpen}
        onClose={handleVideoModelDialogClose}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Select Video Model</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Choose a video model for generating videos.
          </DialogContentText>
          <FormControl fullWidth>
            <InputLabel id="video-model-select-label">Video Model</InputLabel>
            <Select
              labelId="video-model-select-label"
              value={selectedVideoModel}
              onChange={(e) => setSelectedVideoModel(e.target.value)}
              label="Video Model"
            >
              <MenuItem value="veo-3.0-generate-preview">
                <Box>
                  <Typography>veo-3.0-generate-preview (Google)</Typography>
                  <Typography variant="caption" color="text.secondary">
                    8s video with audio supported
                  </Typography>
                </Box>
              </MenuItem>
              <MenuItem value="gen4_turbo">
                <Box>
                  <Typography>gen4_turbo (Runway AI)</Typography>
                  <Typography variant="caption" color="text.secondary">
                    5s video without audio
                  </Typography>
                </Box>
              </MenuItem>
              <MenuItem value="kling-v2.1-std">
                <Box>
                  <Typography>kling-v2.1-std (ReelMind)</Typography>
                  <Typography variant="caption" color="text.secondary">
                    5s video without audio
                  </Typography>
                </Box>
              </MenuItem>
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleVideoModelDialogClose}>Cancel</Button>
          <Button
            onClick={handleVideoModelDialogConfirm}
            variant="contained"
            color="primary"
            disabled={!selectedVideoModel.trim()}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>

      {/* Email-Friendly HTML Dialog */}
      <Dialog
        open={isEmailFriendlyDialogOpen}
        onClose={handleEmailFriendlyDialogClose}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Enable HTML Output</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            You're enabling HTML output for this task. Select any additional HTML features you'd like to enable:
          </DialogContentText>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={tempEmailFriendly}
                  onChange={(e) => setTempEmailFriendly(e.target.checked)}
                  color="primary"
                />
              }
              label={
                <Box>
                  <Typography variant="body1" sx={{ fontWeight: 'medium' }}>
                    Email-Friendly HTML
                  </Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    Creates optimized version for email rendering with inline CSS and no JavaScript
                  </Typography>
                </Box>
              }
            />
            <FormControlLabel
              control={
                <Switch
                  checked={tempRepairImageEmbedding}
                  onChange={(e) => setTempRepairImageEmbedding(e.target.checked)}
                  color="secondary"
                />
              }
              label={
                <Box>
                  <Typography variant="body1" sx={{ fontWeight: 'medium' }}>
                    Repair Image Embedding
                  </Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    Automatically fixes broken image references in HTML output
                  </Typography>
                </Box>
              }
            />

            {/* HTML Template selection from attachments */}
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 'medium', mb: 1 }}>
                HTML Template (optional)
              </Typography>
              <FormControl fullWidth>
                <InputLabel id="html-template-label">Template</InputLabel>
                <Select
                  labelId="html-template-label"
                  value={tempHtmlTemplateFilename || ''}
                  label="Template"
                  onChange={(e) => setTempHtmlTemplateFilename(e.target.value ? String(e.target.value) : null)}
                >
                  <MenuItem value="">None</MenuItem>
                  {(task?.attachments || []).map((att) => (
                    <MenuItem key={att.key} value={att.filename}>
                      {att.filename}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
                Choose one of the uploaded attachments to use as the HTML template.
              </Typography>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleEmailFriendlyDialogClose}>Cancel</Button>
          <Button
            onClick={handleEmailFriendlyDialogConfirm}
            variant="contained"
            color="primary"
          >
            Enable HTML
          </Button>
        </DialogActions>
      </Dialog>


    </Container>
  );
}
