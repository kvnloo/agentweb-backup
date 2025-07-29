import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '@/contexts/AuthContext';
import { buildApiUrl } from '@/config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Search, Filter, Calendar, Image as ImageIcon, ExternalLink, Clock, ArrowUpRight, Play, Zap, Download, Heart } from 'lucide-react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';

interface ResultFile {
  url: string;
  filename: string;
  token: string;
  is_html?: boolean;
  is_favorited?: boolean;
}

interface ExecutionWithImages {
  executionId: string;
  startTime?: string;
  result_files: ResultFile[];
}

interface PendingOrRunningExecution {
  executionId: string;
  status: 'pending' | 'running';
  startTime?: string;
}

interface TaskWithExecutions {
  taskId: string;
  taskName: string;
  createdAt?: string;
  latestExecutionTime?: string;
  latestPendingOrRunningExecution?: PendingOrRunningExecution | null;
  executions: ExecutionWithImages[];
}

const ImagesPage: React.FC = () => {
  const { token } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [tasksWithExecutions, setTasksWithExecutions] = useState<Record<string, TaskWithExecutions>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<string>('latestExecution');
  const [executingTasks, setExecutingTasks] = useState<Set<string>>(new Set());
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchExecutionsWithImages = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await axios.get<Record<string, TaskWithExecutions>>(
        buildApiUrl('/api/tasks/executions/with-images'),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      setTasksWithExecutions(response.data);
    } catch (err: any) {
      console.error('Error fetching executions with images:', err);
      setError(err.response?.data?.message || 'Failed to load images');
    } finally {
      setLoading(false);
    }
  };

  // Check if there are any pending or running executions
  const hasActiveExecutions = () => {
    return Object.values(tasksWithExecutions).some(
      task => task.latestPendingOrRunningExecution !== null
    );
  };

  // Start auto-refresh when there are active executions
  const startAutoRefresh = () => {
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
    }
    
    refreshIntervalRef.current = setInterval(() => {
      fetchExecutionsWithImages();
    }, 5000); // Refresh every 5 seconds
  };

  // Stop auto-refresh
  const stopAutoRefresh = () => {
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
  };

  useEffect(() => {
    fetchExecutionsWithImages();
  }, []);

  // Monitor for active executions and start/stop auto-refresh accordingly
  useEffect(() => {
    if (hasActiveExecutions()) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }

    // Cleanup on unmount
    return () => {
      stopAutoRefresh();
    };
  }, [tasksWithExecutions]);

  const handleGenerateMore = async (taskId: string) => {
    if (!token) {
      toast({
        title: "Error",
        description: "Authentication token not found. Please log in.",
        variant: "destructive",
      });
      return;
    }

    setExecutingTasks(prev => new Set(prev).add(taskId));
    
    try {
      await axios.post(
        buildApiUrl(`/api/tasks/${taskId}/execute`),
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      toast({ 
        title: "Success", 
        description: "Task execution started. New images will appear shortly." 
      });
      
      // Refresh the data after a short delay to show the new execution
      setTimeout(() => {
        fetchExecutionsWithImages();
      }, 2000);
      
    } catch (err: any) {
      console.error('Failed to execute task:', err);
      toast({
        title: "Error Executing Task",
        description: err.response?.data?.message || "Could not start task execution.",
        variant: "destructive",
      });
    } finally {
      setExecutingTasks(prev => {
        const newSet = new Set(prev);
        newSet.delete(taskId);
        return newSet;
      });
    }
  };

  const formatDate = (dateString: string | undefined) => {
    if (!dateString) return 'Unknown';
    try {
      return format(new Date(dateString), 'MMM dd, yyyy HH:mm');
    } catch {
      return 'Invalid date';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'running':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300';
    }
  };

  const handleViewImage = (imageUrl: string) => {
    window.open(imageUrl, '_blank');
  };

  const handleFavoriteImage = async (executionId: string, imageUrl: string) => {
    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/executions/${executionId}/favorite-image`),
        { imageUrl },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        // Update the specific image's favorite status in local state
        setTasksWithExecutions(prev => {
          const updated = { ...prev };
          Object.keys(updated).forEach(taskId => {
            const task = updated[taskId];
            task.executions = task.executions.map(execution => {
              if (execution.executionId === executionId) {
                return {
                  ...execution,
                  result_files: execution.result_files.map(file => {
                    if (file.url === imageUrl) {
                      return {
                        ...file,
                        is_favorited: response.data.is_favorited
                      };
                    }
                    return file;
                  })
                };
              }
              return execution;
            });
          });
          return updated;
        });
        
        toast({
          title: response.data.is_favorited ? "Added to Favorites" : "Removed from Favorites",
          description: response.data.is_favorited 
            ? "Image has been added to your favorites." 
            : "Image has been removed from your favorites.",
        });
      }
    } catch (error: any) {
      console.error('Error toggling favorite status:', error);
      toast({
        title: "Error",
        description: error.response?.data?.message || "Failed to update favorite status.",
        variant: "destructive",
      });
    }
  };

  // Convert to array of tasks and filter/sort
  const allTasks = Object.values(tasksWithExecutions)
    .filter(task => {
      const matchesSearch = task.taskName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           task.taskId.toLowerCase().includes(searchTerm.toLowerCase());
      return matchesSearch;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.taskName.localeCompare(b.taskName);
        case 'taskId':
          return a.taskId.localeCompare(b.taskId);
        case 'createdAt':
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        case 'latestExecution':
          return (b.latestExecutionTime || '').localeCompare(a.latestExecutionTime || ''); // Latest first
        default:
          return 0;
      }
    });

  const totalImages = allTasks.reduce(
    (total, task) => total + task.executions.reduce((taskTotal, execution) => taskTotal + execution.result_files.length, 0),
    0
  );

  const totalExecutions = allTasks.reduce(
    (total, task) => total + task.executions.length,
    0
  );

  const hasActiveExecutionsInView = allTasks.some(task => task.latestPendingOrRunningExecution !== null);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex items-center space-x-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>Loading images...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Images</h1>
          <p className="text-gray-600 dark:text-gray-400">
            All images generated by your tasks ({totalImages} images from {totalExecutions} executions across {allTasks.length} tasks)
            {hasActiveExecutionsInView && (
              <span className="ml-2 text-blue-600 dark:text-blue-400">
                • Auto-refreshing every 5 seconds
              </span>
            )}
          </p>
        </div>
        <Button onClick={fetchExecutionsWithImages} variant="outline">
          <ImageIcon className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
          <Input
            placeholder="Search tasks..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="latestExecution">Latest Execution</SelectItem>
            <SelectItem value="name">Task Name</SelectItem>
            <SelectItem value="taskId">Task ID</SelectItem>
            <SelectItem value="createdAt">Task Created</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Results */}
      {allTasks.length === 0 ? (
        <div className="text-center py-12">
          <ImageIcon className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            No images found
          </h3>
          <p className="text-gray-600 dark:text-gray-400">
            {Object.keys(tasksWithExecutions).length === 0 
              ? "No tasks have generated images yet. Run some image-generating tasks to see them here."
              : "No tasks match your current search."
            }
          </p>
        </div>
      ) : (
        <div className="grid gap-6">
          {allTasks.map((task) => {
            const hasActiveExecution = task.latestPendingOrRunningExecution !== null;
            const isCurrentlyExecuting = executingTasks.has(task.taskId);
            const canGenerateMore = !hasActiveExecution && !isCurrentlyExecuting;
            
            return (
              <Card key={task.taskId} className="overflow-hidden">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-lg font-semibold text-gray-900 dark:text-white">
                          {task.taskName}
                        </CardTitle>
                        <button 
                          onClick={() => window.location.href = `/tasks/${task.taskId}`}
                          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                        >
                          <ArrowUpRight className="h-3 w-3" />
                          View Task
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-xs">
                          {task.taskId}
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          {task.executions.length} execution{task.executions.length !== 1 ? 's' : ''}
                        </Badge>
                        {hasActiveExecution && (
                          <Badge className={`text-xs ${getStatusColor(task.latestPendingOrRunningExecution!.status)}`}>
                            <Zap className="h-3 w-3 mr-1" />
                            {task.latestPendingOrRunningExecution!.status}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-2 text-sm text-gray-500 dark:text-gray-400">
                        <Clock className="h-4 w-4" />
                        <span>Task created: {formatDate(task.createdAt)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-sm text-gray-500 dark:text-gray-400">
                        <Calendar className="h-4 w-4" />
                        <span>Latest execution: {formatDate(task.latestExecutionTime)}</span>
                      </div>
                      {hasActiveExecution && (
                        <div className="flex items-center gap-2 mt-1 text-sm text-blue-600 dark:text-blue-400">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Generating images... Started: {formatDate(task.latestPendingOrRunningExecution!.startTime)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <Button
                        onClick={() => handleGenerateMore(task.taskId)}
                        disabled={!canGenerateMore}
                        size="sm"
                        className="whitespace-nowrap"
                      >
                        {isCurrentlyExecuting ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Starting...
                          </>
                        ) : hasActiveExecution ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            In Progress
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4 mr-2" />
                            Generate More
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {task.executions.flatMap((execution, executionIndex) => 
                      execution.result_files.map((file, fileIndex) => (
                        <div key={`${execution.executionId}-${fileIndex}`} className="group relative">
                          <div className="aspect-square overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                            <img
                              src={file.url}
                              alt={file.filename}
                              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgdmlld0JveD0iMCAwIDIwMCAyMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIiBmaWxsPSIjRjNGNEY2Ii8+CjxwYXRoIGQ9Ik02MCAxMDBDNjAgODguOTU0MyA2OC45NTQzIDgwIDgwIDgwQzkxLjA0NTcgODAgMTAwIDg4Ljk1NDMgMTAwIDEwMEMxMDAgMTExLjA0NiA5MS4wNDU3IDEyMCA4MCAxMjBDNjguOTU0MyAxMjAgNjAgMTExLjA0NiA2MCAxMDBaIiBmaWxsPSIjOUI5QkEwIi8+CjxwYXRoIGQ9Ik04MCAxNDBDNjguOTU0MyAxNDAgNjAgMTMxLjA0NiA2MCAxMjBMMTAwIDEyMEMxMDAgMTMxLjA0NiA5MS4wNDU3IDE0MCA4MCAxNDBaIiBmaWxsPSIjOUI5QkEwIi8+Cjwvc3ZnPgo=';
                              }}
                            />
                          </div>
                          <div className="mt-2">
                            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                              {file.filename}
                            </p>
                            <div className="flex items-center gap-1 mt-1">
                              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                                Execution: {execution.executionId}
                              </p>
                              <button 
                                onClick={() => window.location.href = `/tasks/${task.taskId}/executions/${execution.executionId}/result`}
                                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors ml-1"
                              >
                                <ArrowUpRight className="h-3 w-3" />
                                View
                              </button>
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                              Started: {formatDate(execution.startTime)}
                            </p>
                            <div className="flex items-center gap-1 mt-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-800"
                                onClick={() => handleViewImage(file.url)}
                                title="View Image"
                              >
                                <Download className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-800"
                                onClick={() => handleFavoriteImage(execution.executionId, file.url)}
                                title={file.is_favorited ? "Remove from Favorites" : "Add to Favorites"}
                              >
                                <Heart 
                                  className={`h-4 w-4 ${
                                    file.is_favorited 
                                      ? 'fill-red-500 text-red-500' 
                                      : 'text-gray-400 hover:text-red-500'
                                  }`} 
                                />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ImagesPage; 