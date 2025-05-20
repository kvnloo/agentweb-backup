import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import axios, { AxiosError } from "axios";
import { useAuth } from "@/contexts/AuthContext";
import { buildApiUrl } from "@/config";
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
} from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Separator } from "@/components/ui/separator";
import { TaskScheduler } from "@/components/tasks/TaskScheduler";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

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

// Update TaskDetail interface
interface TaskDetail extends Task {
  parameterValues?: Record<string, string>;
  executions?: Execution[];
  resultSummary?: string;
  resultLink?: string;
  isInteractive?: boolean;
  isDeepResearch?: boolean;
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
  const { token } = useAuth();
  const navigate = useNavigate();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isUpdatingInteractive, setIsUpdatingInteractive] = useState(false);

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
      setError("Task ID or authentication token missing.");
      setLoading(false);
      return;
    }
    if (!taskRef.current) {
      setLoading(true);
    }
    setError(null);
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
        setError(err.response?.data?.message || "Failed to load task data.");
      } else {
        setError("Failed to load task data.");
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

      if (shouldPoll) {
        console.log(
          "Polling: Latest execution is active (via ref), fetching updates..."
        );
        fetchTaskAndExecutions();
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [taskId, token]);

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

  const UserInteractionDialog = ({ execution, onRespond }) => {
    const [response, setResponse] = useState("");
    const [selectedInteraction, setSelectedInteraction] = useState(null);
    const [error, setError] = useState("");
    if (!execution.userInteractions?.length || execution.status !== "running")
      return null;
    const pendingCount = execution.userInteractions.filter(
      (i) => i.status === "pending"
    ).length;
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
      } catch (err) {
        setError("Failed to send response");
      }
    };
    return (
      <div className="rounded border p-4 my-4 bg-muted">
        <div className="flex items-center justify-between mb-2">
          <span className="font-semibold">Agent Questions</span>
          <span>
            <span
              className={`inline-block px-2 py-1 rounded text-xs ${
                pendingCount > 0
                  ? "bg-yellow-200 text-yellow-800"
                  : "bg-green-200 text-green-800"
              }`}
            >
              {pendingCount > 0 ? `${pendingCount} Pending` : "All Answered"}
            </span>
          </span>
        </div>
        <ul className="space-y-4">
          {execution.userInteractions.map((interaction, idx) => (
            <li key={interaction.id} className="border-b pb-2 last:border-b-0">
              <div className="font-medium mb-1">{interaction.question}</div>
              {interaction.screenshot_url && (
                <img
                  src={interaction.screenshot_url}
                  alt="Screenshot"
                  className="max-w-xs mb-2 border rounded"
                />
              )}
              {interaction.response ? (
                <div className="bg-green-50 text-green-800 rounded px-2 py-1 text-sm">
                  {interaction.response}
                </div>
              ) : interaction.status === "pending" ? (
                selectedInteraction?.id === interaction.id ? (
                  <div>
                    <textarea
                      className="w-full border rounded p-2 mb-2"
                      rows={2}
                      value={response}
                      onChange={(e) => setResponse(e.target.value)}
                    />
                    {error && (
                      <div className="text-red-600 text-xs mb-1">{error}</div>
                    )}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedInteraction(null);
                          setResponse("");
                          setError("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={handleRespond}
                        disabled={!response.trim()}
                      >
                        Send Response
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedInteraction(interaction)}
                  >
                    Respond
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const handleUserResponse = async (
    executionId,
    interactionId,
    userResponse
  ) => {
    try {
      await axios.put(
        buildApiUrl(
          `/api/tasks/${task?.taskId}/executions/${executionId}/interactions/${interactionId}`
        ),
        { response: userResponse },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      fetchTaskAndExecutions();
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to send response.",
        variant: "destructive",
      });
    }
  };

  if (loading && !task) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !task) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error Loading Task</AlertTitle>
        <AlertDescription>{error || "Task not found."}</AlertDescription>
      </Alert>
    );
  }

  // Define latestExecution for use in CardContent
  const latestExecution = executions.length > 0 ? executions[0] : null;

  return (
    <div className="container mx-auto py-8 space-y-6 relative">
      {/* Hidden divs for the full result of each execution */}
      {executions.map(
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

      <Button variant="outline" size="sm" onClick={() => navigate("/tasks")}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to Tasks
      </Button>

      <Card>
        <CardHeader>
          <div className="flex justify-between items-start gap-2 mb-2">
            <CardTitle className="text-2xl font-bold">{task.name}</CardTitle>
            {getTaskStatusBadge(task.status)}
          </div>
          <CardDescription className="text-xs text-muted-foreground">
            Task ID: {task.taskId} | Created: {formatDate(task.createdAt)}
          </CardDescription>
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
                  <Button onClick={handleRunTask} disabled={isDisabled}>
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
          {/* Scheduling Section */}
          <TaskScheduler taskId={task.taskId} />
          {/* Interactive Mode Toggle */}
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
          {/* User Interaction Dialog for latest running execution */}
          {(() => {
            if (
              latestExecution &&
              latestExecution.status === "running" &&
              latestExecution.userInteractions?.length > 0
            ) {
              return (
                <UserInteractionDialog
                  execution={latestExecution}
                  onRespond={handleUserResponse}
                />
              );
            }
            return null;
          })()}
        </CardContent>
      </Card>

      <div>
        <h2 className="text-2xl font-semibold mb-4">Executions</h2>
        {executions && executions.length > 0 ? (
          <div className="space-y-4">
            {executions.map((exec) => (
              <Card
                key={exec.executionId}
                className="bg-slate-50 dark:bg-slate-800/50 hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => handleExecutionClick(exec)}
              >
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-center gap-2">
                    <CardDescription>
                      Execution ID: {exec.executionId}
                    </CardDescription>
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
    </div>
  );
};

export default TaskDetailsPage;
