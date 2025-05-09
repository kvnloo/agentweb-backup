import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '@/contexts/AuthContext';
import { buildApiUrl } from '@/config';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, AlertCircle, Play, CheckCircle, RotateCcw, Clock, ArrowLeft, XCircle, History, X, Folder } from 'lucide-react';
import { toast } from "@/components/ui/use-toast";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Separator } from '@/components/ui/separator';

// Define Execution Status type
type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'queued';

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
}

// Update TaskDetail interface
interface TaskDetail extends Task {
  parameterValues?: Record<string, string>;
  executions?: Execution[];
  resultSummary?: string;
  resultLink?: string;
}

// Base Task interface
interface Task {
  taskId: string;
  name: string;
  status: ExecutionStatus | 'archived';
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
    case 'completed':
      return <Badge className="bg-green-100 text-green-800 border-green-200 hover:bg-green-200"><CheckCircle className="h-3 w-3 mr-1" /> Completed</Badge>;
    case 'running':
      return <Badge className="bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200"><RotateCcw className="h-3 w-3 mr-1 animate-spin" /> Running</Badge>;
    case 'failed':
      return <Badge className="bg-red-100 text-red-800 border-red-200 hover:bg-red-200"><AlertCircle className="h-3 w-3 mr-1" /> Failed</Badge>;
    case 'queued':
    case 'pending':
      return <Badge className="bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200"><Clock className="h-3 w-3 mr-1" /> Queued</Badge>; 
    default:
      return <Badge variant="secondary">{status}</Badge>; 
  }
};

// Helper for Task status (might differ slightly, e.g., no spin for task pending)
const getTaskStatusBadge = (status: Task['status']) => {
  if (status === 'archived') return <Badge variant="outline">Archived</Badge>;
  // Use execution badge for other statuses, but maybe without spin for pending?
  if (status === 'running') return getExecutionStatusBadge(status);
  if (status === 'pending' || status === 'queued') return <Badge className="bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200"><Clock className="h-3 w-3 mr-1" /> Queued</Badge>; 
  return getExecutionStatusBadge(status as ExecutionStatus); // Reuse logic for completed/failed
};

// Helper function for formatting dates (can be moved to utils later)
const formatDate = (dateStr?: string) => {
  if (!dateStr) return 'N/A';
  try {
    // Attempt to handle various date string formats
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) { // Check if date is invalid
        // Try to parse if it's a string that looks like ISO but might miss 'T' or 'Z'
        const parts = dateStr.match(/(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):?(\d{2}))?/);
        if (parts) {
            const isoStr = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}${parts[7] || 'Z'}`;
            const parsedDate = new Date(isoStr);
            if (!isNaN(parsedDate.getTime())) return parsedDate.toLocaleString();
        }
        return 'Invalid Date';
    }
    return date.toLocaleString();
  } catch (e) {
    return 'Invalid Date';
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
      const taskResponse = await axios.get(buildApiUrl(`/api/tasks/${taskId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const taskData = taskResponse.data as TaskDetail;
      setTask(taskData);

      const executionsResponse = await axios.get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
         headers: { Authorization: `Bearer ${token}` },
      });
      const sortedExecutions = (executionsResponse.data as Execution[]).sort((a, b) => 
        new Date(b.startTime || 0).getTime() - new Date(a.startTime || 0).getTime()
      );
      setExecutions(sortedExecutions);

    } catch (err: any) {
      console.error("Failed to fetch task data:", err);
      setError(err.response?.data?.message || "Failed to load task data.");
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
      const latestExecution = currentExecutions.length > 0 ? currentExecutions[0] : null;
      
      const shouldPoll = latestExecution && 
                         ['running', 'pending', 'queued'].includes(latestExecution.status);

      if (shouldPoll) {
        console.log('Polling: Latest execution is active (via ref), fetching updates...');
        fetchTaskAndExecutions(); 
      }
    }, 5000); 

    return () => clearInterval(intervalId);
  }, [taskId, token]);

  const handleRunTask = async () => {
    if (!token || !taskId) {
      toast({ title: "Error", description: "Cannot run task. Missing ID or token.", variant: "destructive" });
      return;
    }
    setIsRunning(true);
    try {
      await axios.post(buildApiUrl(`/api/tasks/${taskId}/execute`), {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      toast({ title: "Success", description: "Task execution started." });
      fetchTaskAndExecutions(); 
    } catch (err: any) {
      console.error("Failed to run task:", err);
      toast({ 
        title: "Error Running Task", 
        description: err.response?.data?.message || "Could not start task execution.",
        variant: "destructive" 
      });
    } finally {
      setIsRunning(false);
    }
  };

  const handleExecutionClick = (execution: Execution) => {
    if (task) { // Ensure task is available to get taskId
      navigate(`/tasks/${task.taskId}/executions/${execution.executionId}/result`);
    }
  };

  if (loading && !task) {
     return <div className="flex justify-center items-center h-64"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
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

  return (
    <div className="container mx-auto py-8 space-y-6 relative">
      {/* Hidden divs for the full result of each execution */}
      {executions.map((exec, index) => (
        exec.result && (
          <div 
            key={`hidden-exec-result-${exec.executionId || index}`} 
            id={`full-exec-result-${exec.executionId || index}`} 
            className="hidden-execution-result"
            style={{ display: 'none' }} 
            aria-hidden="true"
          >
            {exec.result}
          </div>
        )
      ))}

      <Button variant="outline" size="sm" onClick={() => navigate('/tasks')} >
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
          {task.prompt && (
            <div>
              <h3 className="font-semibold mb-1 text-sm">Prompt:</h3>
              <pre className="text-sm bg-gray-50 dark:bg-gray-800 p-3 rounded whitespace-pre-wrap font-mono text-xs">
                {task.prompt}
              </pre>
            </div>
          )}
          <div className="pt-4 border-t">
            {(() => { 
              const latestExecution = executions.length > 0 ? executions[0] : null;
              const isTaskActive = ['running', 'pending', 'queued'].includes(task.status);
              const isLatestExecutionActive = latestExecution && ['running', 'pending', 'queued'].includes(latestExecution.status);
              const isDisabled = isRunning || isTaskActive || isLatestExecutionActive;
              
              return (
                <>
                  <Button 
                    onClick={handleRunTask} 
                    disabled={isDisabled}
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
                    <CardDescription>Execution ID: {exec.executionId}</CardDescription>
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
                  {exec.status === 'failed' && exec.error && (
                    <Alert variant="destructive" className="mt-2 p-2 text-xs">
                      <AlertCircle className="h-3 w-3" />
                      <AlertDescription>{exec.error}</AlertDescription>
                    </Alert>
                  )}
                  {exec.result && (
                     <p className="pt-2 mt-2 border-t border-dashed">
                       Result: {exec.result.substring(0, 100)}{exec.result.length > 100 ? '...' : ''}
                     </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">No executions found for this task.</p>
        )}
      </div>
    </div>
  );
};

export default TaskDetailsPage; 