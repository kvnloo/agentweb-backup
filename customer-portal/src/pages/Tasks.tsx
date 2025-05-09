import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useAuth } from '@/contexts/AuthContext';
import { buildApiUrl } from '@/config';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, AlertCircle, ChevronRight, FolderOpen } from 'lucide-react';
import { Link } from 'react-router-dom';

// Define the Task interface based on expected backend structure
interface Task {
  taskId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'queued' | 'archived';
  createdAt: string;
  updatedAt?: string;
  prompt?: string;
  category?: string;
  description?: string;
}

const TasksPage: React.FC = () => {
  const { token } = useAuth();
  const [groupedTasks, setGroupedTasks] = useState<Record<string, Task[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTasksAndGroup = async () => {
      if (!token) {
        setError("Authentication token not found. Please log in.");
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        const response = await axios.get(buildApiUrl('/api/tasks'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        
        const activeTasks = (response.data as Task[]).filter(task => task.status !== 'archived');
        
        const groups: Record<string, Task[]> = {};
        activeTasks.forEach(task => {
          const categoryName = task.category?.trim() ? task.category.trim() : 'Other';
          if (!groups[categoryName]) {
            groups[categoryName] = [];
          }
          groups[categoryName].push(task);
        });

        // Optional: Sort categories (e.g., 'Other' last)
        const sortedCategoryNames = Object.keys(groups).sort((a, b) => {
          if (a === 'Other') return 1;
          if (b === 'Other') return -1;
          return a.localeCompare(b);
        });
        
        const sortedGroupedTasks: Record<string, Task[]> = {};
        sortedCategoryNames.forEach(name => {
            sortedGroupedTasks[name] = groups[name];
        });

        setGroupedTasks(sortedGroupedTasks);

      } catch (err: any) {
        console.error("Failed to fetch tasks:", err);
        setError(err.response?.data?.message || "Failed to load tasks. Please try again later.");
      } finally {
        setLoading(false);
      }
    };

    fetchTasksAndGroup();
  }, [token]);

  const getStatusBadgeVariant = (status: Task['status']) => {
    switch (status) {
      case 'completed': return 'default';
      case 'running':
      case 'pending': 
      case 'queued': return 'secondary';
      case 'failed': return 'destructive';
      case 'archived': return 'outline';
      default: return 'secondary';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric'
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="ml-2 text-muted-foreground">Loading tasks...</p>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const categoryOrder = Object.keys(groupedTasks);
  const hasTasks = categoryOrder.some(categoryName => groupedTasks[categoryName].length > 0);

  return (
    <div className="container mx-auto py-8">
      <h1 className="text-3xl font-bold mb-8 text-gray-800 dark:text-white">My Tasks</h1>
      
      {!hasTasks ? (
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 text-center">
          <p className="text-gray-600 dark:text-gray-300">
            You haven't created any active tasks yet.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {categoryOrder.map((categoryName) => (
            groupedTasks[categoryName].length > 0 && (
              <section key={categoryName}>
                <h2 className="text-2xl font-semibold mb-4 flex items-center text-gray-700 dark:text-gray-300">
                  <FolderOpen className="mr-3 h-6 w-6 text-primary" /> 
                  {categoryName}
                </h2>
                <ul className="bg-white dark:bg-gray-800 shadow rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
                  {groupedTasks[categoryName].map((task) => (
                    <li key={task.taskId}>
                      <Link 
                        to={`/tasks/${task.taskId}`} 
                        className="block hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors duration-150 p-4"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-md font-medium text-primary truncate" title={task.name}>
                              {task.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Created: {formatDate(task.createdAt)}
                            </p>
                            {task.description && (
                                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 line-clamp-2" title={task.description}>
                                    {task.description}
                                </p>
                            )}
                          </div>
                          <div className="flex items-center space-x-3 ml-4">
                            <ChevronRight className="h-5 w-5 text-gray-400 dark:text-gray-500" />
                          </div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )
          ))}
        </div>
      )}
    </div>
  );
};

export default TasksPage;
