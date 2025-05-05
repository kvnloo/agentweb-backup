
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, CheckCircle, AlertCircle, RotateCcw, RefreshCcw, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import TaskDetailModal, { TaskExecution, TaskSubscriber } from "@/components/TaskDetailModal";

interface Task {
  id: string;
  title: string;
  description: string;
  status: "completed" | "failed" | "running" | "queued";
  created: string;
  completed?: string;
  executions?: TaskExecution[];
  preferred_llm?: string;
  subscribers?: TaskSubscriber[];
  schedule?: {
    frequency: string;
    enabled: boolean;
  };
  options?: {
    emailMe: boolean;
    interactiveMode: boolean;
    performDeepResearch: boolean;
    complexTask: boolean;
    extractPageContent: boolean;
    validateOutput: boolean;
    outputAsJSON: boolean;
  }
}

const Tasks = () => {
  const [tasks, setTasks] = useState<Task[]>([
    {
      id: "task-1",
      title: "Competitor Analysis: Tech Industry",
      description: "Analysis of top 5 competitors in the tech sector",
      status: "completed",
      created: "2025-04-30T14:30:00",
      completed: "2025-04-30T15:45:00",
      preferred_llm: "gpt-4o",
      executions: [
        {
          id: "exec-1",
          status: "completed",
          startedAt: "2025-04-30T14:30:00",
          completedAt: "2025-04-30T15:45:00",
          prompt: "Analysis of top 5 competitors in the tech sector",
          result: "Identified key strengths and weaknesses of major competitors including product offerings, pricing strategies, and market positioning."
        }
      ],
      subscribers: [
        {
          email: "user@example.com",
          subscribedOn: "2025-04-29T10:15:00"
        }
      ],
      options: {
        emailMe: true,
        interactiveMode: false,
        performDeepResearch: true,
        complexTask: true,
        extractPageContent: false,
        validateOutput: true,
        outputAsJSON: false
      }
    },
    {
      id: "task-2",
      title: "Market Trends Research",
      description: "Identify emerging trends in digital marketing",
      status: "completed",
      created: "2025-04-29T10:15:00",
      completed: "2025-04-29T11:30:00",
      preferred_llm: "gpt-4.5-preview",
      executions: [
        {
          id: "exec-2",
          status: "completed",
          startedAt: "2025-04-29T10:15:00",
          completedAt: "2025-04-29T11:30:00",
          prompt: "Identify emerging trends in digital marketing",
          result: "Key trends identified: rise of AI-powered marketing tools, increased focus on personalized experiences, and growth in interactive content marketing."
        }
      ],
      schedule: {
        frequency: "weekly",
        enabled: true
      }
    },
    {
      id: "task-3",
      title: "Audience Analysis",
      description: "Demographics and behavior analysis of target audience",
      status: "running",
      created: "2025-05-01T09:20:00",
      preferred_llm: "gpt-4o-mini"
    },
    {
      id: "task-4",
      title: "Content Strategy Development",
      description: "Create content strategy for Q3",
      status: "queued",
      created: "2025-05-01T08:45:00"
    },
    {
      id: "task-5",
      title: "Ad Copy Analysis",
      description: "Performance analysis of recent ad campaigns",
      status: "failed",
      created: "2025-04-28T16:10:00",
      completed: "2025-04-28T16:35:00",
      executions: [
        {
          id: "exec-5",
          status: "failed",
          startedAt: "2025-04-28T16:10:00",
          completedAt: "2025-04-28T16:35:00",
          prompt: "Performance analysis of recent ad campaigns",
          result: "Analysis failed due to insufficient data. Please ensure all campaign metrics are properly tracked before running analysis."
        }
      ]
    }
  ]);

  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const getStatusBadge = (status: Task["status"]) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" /> Completed</Badge>;
      case "running":
        return <Badge className="bg-blue-500"><RotateCcw className="h-3 w-3 mr-1 animate-spin" /> Running</Badge>;
      case "failed":
        return <Badge className="bg-red-500"><AlertCircle className="h-3 w-3 mr-1" /> Failed</Badge>;
      case "queued":
        return <Badge className="bg-gray-500"><Clock className="h-3 w-3 mr-1" /> Queued</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const getAggregatedLearnings = () => {
    const completedTasks = tasks.filter(task => task.status === "completed");
    
    if (completedTasks.length === 0) {
      return "No completed tasks to generate learnings from.";
    }
    
    return "Based on the completed tasks, we've identified key market trends in the tech industry and analyzed competitive strategies. Our research indicates growing demand for AI-powered marketing tools and increased focus on personalized customer experiences.";
  };

  const recallTask = (taskId: string) => {
    setTasks(currentTasks => 
      currentTasks.map(task => {
        if (task.id === taskId) {
          return {
            ...task,
            status: "queued" as const,
            completed: undefined // Remove completion date when recalled
          };
        }
        return task;
      })
    );
    toast.success("Task recalled and added to the queue");
  };

  const runTask = (taskId: string) => {
    setTasks(currentTasks => 
      currentTasks.map(task => {
        if (task.id === taskId) {
          return {
            ...task,
            status: "running" as const,
          };
        }
        return task;
      })
    );
  };

  const archiveTask = (taskId: string) => {
    setTasks(currentTasks => 
      currentTasks.filter(task => task.id !== taskId)
    );
  };

  const updateTask = (taskId: string, updates: any) => {
    setTasks(currentTasks => 
      currentTasks.map(task => {
        if (task.id === taskId) {
          return {
            ...task,
            ...updates
          };
        }
        return task;
      })
    );
  };

  const openTaskModal = (task: Task) => {
    setSelectedTask(task);
    setIsModalOpen(true);
  };

  return (
    <div className="w-full space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Tasks</h1>
        <p className="text-muted-foreground">Manage and track your marketing tasks</p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Overall Learnings</CardTitle>
          <CardDescription>Summary insights from completed research tasks</CardDescription>
        </CardHeader>
        <CardContent>
          <p>{getAggregatedLearnings()}</p>
        </CardContent>
      </Card>

      <Tabs defaultValue="active" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="active">Active Tasks</TabsTrigger>
          <TabsTrigger value="history">Task History</TabsTrigger>
        </TabsList>
        
        <TabsContent value="active" className="space-y-4">
          {tasks
            .filter(task => ["running", "queued"].includes(task.status))
            .map(task => (
              <Card key={task.id} className="mb-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => openTaskModal(task)}>
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <FileText className="h-5 w-5" />
                      {task.title}
                    </CardTitle>
                    {getStatusBadge(task.status)}
                  </div>
                  <CardDescription>{task.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center text-sm text-muted-foreground">
                    <Calendar className="h-4 w-4 mr-1" />
                    <span>Started: {formatDate(task.created)}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
            
          {tasks.filter(task => ["running", "queued"].includes(task.status)).length === 0 && (
            <p className="text-center text-muted-foreground py-8">No active tasks at the moment.</p>
          )}
        </TabsContent>
        
        <TabsContent value="history" className="space-y-4">
          {tasks
            .filter(task => ["completed", "failed"].includes(task.status))
            .map(task => (
              <Card key={task.id} className="mb-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => openTaskModal(task)}>
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <FileText className="h-5 w-5" />
                      {task.title}
                    </CardTitle>
                    {getStatusBadge(task.status)}
                  </div>
                  <CardDescription>{task.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                    <div className="flex items-center">
                      <Calendar className="h-4 w-4 mr-1" />
                      <span>Started: {formatDate(task.created)}</span>
                    </div>
                    {task.completed && (
                      <div className="flex items-center">
                        <Clock className="h-4 w-4 mr-1" />
                        <span>Completed: {formatDate(task.completed)}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
                <CardFooter className="pt-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={(e) => {
                      e.stopPropagation();
                      recallTask(task.id);
                    }}
                    className="ml-auto"
                  >
                    <RefreshCcw className="h-4 w-4 mr-2" /> Recall Task
                  </Button>
                </CardFooter>
              </Card>
            ))}
            
          {tasks.filter(task => ["completed", "failed"].includes(task.status)).length === 0 && (
            <p className="text-center text-muted-foreground py-8">No task history available.</p>
          )}
        </TabsContent>
      </Tabs>

      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onRunTask={runTask}
          onArchiveTask={archiveTask}
          onUpdateTask={updateTask}
        />
      )}
    </div>
  );
};

export default Tasks;
