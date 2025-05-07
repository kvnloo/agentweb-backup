import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useAuth } from '@/contexts/AuthContext';
import { buildApiUrl } from '@/config';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Loader2, AlertCircle } from 'lucide-react';

// Define the Task interface based on expected backend structure
interface Task {
  taskId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'queued' | 'archived';
  createdAt: string;
  updatedAt?: string;
  prompt?: string;
  // Add other fields as necessary, e.g., resultSummary, resultLink, etc.
}

const TasksPage: React.FC = () => {
  const { token } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTasks = async () => {
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
        // Filter out archived tasks before setting state
        const activeTasks = (response.data as Task[]).filter(task => task.status !== 'archived');
        setTasks(activeTasks);
      } catch (err: any) {
        console.error("Failed to fetch tasks:", err);
        setError(err.response?.data?.message || "Failed to load tasks. Please try again later.");
      } finally {
        setLoading(false);
      }
    };

    fetchTasks();
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

  return (
    <div className="container mx-auto py-8">
      <h1 className="text-3xl font-bold mb-8 text-gray-800 dark:text-white">My Tasks</h1>
      
      {tasks.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 text-center">
          <p className="text-gray-600 dark:text-gray-300">
            You haven't created any tasks yet.
          </p>
          {/* Optional: Add a button/link to go to Dashboard to create tasks */}
          {/* <Button asChild className="mt-4"><Link to="/">Create a Task</Link></Button> */}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tasks.map((task) => (
            <Card key={task.taskId} className="hover:shadow-lg transition-shadow duration-200">
              <CardHeader>
                <CardTitle className="text-xl truncate" title={task.name}>{task.name}</CardTitle>
                <Badge variant={getStatusBadgeVariant(task.status)} className="capitalize">
                  {task.status}
                </Badge>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-1">
                  Created: {new Date(task.createdAt).toLocaleDateString()} {new Date(task.createdAt).toLocaleTimeString()}
                </p>
                {task.updatedAt && task.status !== 'running' && task.status !== 'pending' && task.status !== 'queued' && (
                  <p className="text-sm text-muted-foreground">
                    Last Updated: {new Date(task.updatedAt).toLocaleDateString()} {new Date(task.updatedAt).toLocaleTimeString()}
                  </p>
                )}
                {task.prompt && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 line-clamp-2" title={task.prompt}>
                        <strong>Prompt:</strong> {task.prompt}
                    </p>
                )}
                {/* Future: Add button for View Details -> opens a modal or navigates */}
                {/* <Button variant="outline" size="sm" className="mt-4 w-full">View Details</Button> */}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default TasksPage;
