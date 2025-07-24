import React, { useEffect, useState } from "react";
import axios from "axios";
import { useAuth } from "@/contexts/AuthContext";
import { buildApiUrl } from "@/config";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  AlertCircle,
  ChevronRight,
  FolderOpen,
  Clock,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Define the Task interface
interface Task {
  taskId: string;
  name: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "queued"
    | "archived";
  createdAt: string;
  updatedAt?: string;
  prompt?: string;
  category?: string;
  description?: string;
}

interface CategoryTaskHistoryProps {
  category: string;
  limit?: number; // Optional limit for number of tasks to show
}

export const CategoryTaskHistory: React.FC<CategoryTaskHistoryProps> = ({
  category,
  limit = 5,
}) => {
  const { token } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      pending: { className: "bg-yellow-500", label: "Pending" },
      running: { className: "bg-blue-500", label: "Running" },
      completed: { className: "bg-green-500", label: "Completed" },
      failed: { className: "bg-red-500", label: "Failed" },
      queued: { className: "bg-gray-500", label: "Queued" },
      archived: { className: "bg-gray-400", label: "Archived" },
    };

    const config = statusConfig[status] || {
      className: "bg-gray-500",
      label: status,
    };
    return (
      <Badge className={`${config.className} text-white text-xs`}>
        {config.label}
      </Badge>
    );
  };

  const getCategoryDisplayName = (category: string) => {
    if (category === "General") {
      return "General & Other";
    }
    return category;
  };

  useEffect(() => {
    const fetchCategoryTasks = async () => {
      if (!token) {
        setError("Authentication token not found. Please log in.");
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const response = await axios.get(buildApiUrl("/api/tasks"), {
          headers: { Authorization: `Bearer ${token}` },
        });

        const activeTasks = (response.data as Task[]).filter(
          (task) => task.status !== "archived"
        );

        // Filter tasks by category
        const categoryTasks = activeTasks.filter((task) => {
          const taskCategory = task.category?.trim();
          if (category === "Other") {
            // For "Other" category, include tasks with no category or empty category
            return !taskCategory;
          }
          if (category === "General") {
            // For "General" category on dashboard, include both "General" tasks and uncategorized tasks
            return taskCategory === "General" || !taskCategory;
          }
          return taskCategory === category;
        });

        // Sort by creation date (recent first) and limit
        const sortedTasks = categoryTasks
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          )
          .slice(0, limit);

        setTasks(sortedTasks);
      } catch (err) {
        console.error("Failed to fetch category tasks:", err);
        setError("Failed to load tasks. Please try again later.");
        setTasks([]);
      } finally {
        setLoading(false);
      }
    };

    fetchCategoryTasks();
  }, [token, category, limit]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center">
            <FolderOpen className="mr-2 h-5 w-5" />
            Recent {getCategoryDisplayName(category)} Tasks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="ml-2">Loading tasks...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center">
            <FolderOpen className="mr-2 h-5 w-5" />
            Recent {getCategoryDisplayName(category)} Tasks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center">
            <FolderOpen className="mr-2 h-5 w-5" />
            Recent {getCategoryDisplayName(category)} Tasks
          </CardTitle>
          {tasks.length > 0 && (
            <Link
              to="/tasks"
              className="text-sm text-primary hover:underline flex items-center"
            >
              View all
              <ChevronRight className="h-4 w-4 ml-1" />
            </Link>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-500 dark:text-gray-400">
              No {getCategoryDisplayName(category).toLowerCase()} tasks created
              yet.
            </p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              {category === "General"
                ? "Create a task using the prompt form above or choose from the template categories in the sidebar!"
                : "Use one of the templates above to get started!"}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <Link
                key={task.taskId}
                to={`/tasks/${task.taskId}`}
                className="block p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-primary/50 dark:hover:border-primary/50 hover:shadow-md transition-all duration-200"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <p
                        className="text-sm font-medium text-foreground truncate"
                        title={task.name}
                      >
                        {task.name}
                      </p>
                      {getStatusBadge(task.status)}
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <Clock className="h-3 w-3 mr-1" />
                      <span>{formatDate(task.createdAt)}</span>
                    </div>
                    {task.description && (
                      <p
                        className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2"
                        title={task.description}
                      >
                        {task.description}
                      </p>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 text-gray-400 dark:text-gray-500 ml-2 flex-shrink-0" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
