import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '@/contexts/AuthContext';
import { buildApiUrl } from '@/config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Search, Filter, Calendar, Play, ExternalLink, Clock, ArrowUpRight, Zap, Download, Heart, Plus, Archive, Upload, ChevronDown, X } from 'lucide-react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';

interface ResultFile {
  url: string;
  filename: string;
  token: string;
  is_html?: boolean;
  is_favorited?: boolean;
  is_archived?: boolean;
}

interface ExecutionWithVideos {
  executionId: string;
  startTime?: string;
  result_files: ResultFile[];
}

interface TaskWithExecutions {
  taskId: string;
  taskName: string;
  createdAt: string;
  executions: ExecutionWithVideos[];
  latestExecutionTime?: string;
  latestPendingOrRunningExecution?: {
    executionId: string;
    status: string;
    startTime: string;
  } | null;
}

interface CreateTaskRequest {
  brandGuidelineIds: string[];
  competitorBrandGuidelineIds: string[];
  icpIds: string[];
  brandAssetIds: string[];
  creativeTypes: string[];
  quantity: number;
  additionalInstructions?: string;
}

interface BrandGuideline {
  id: string;
  name: string;
}

interface ICPProfile {
  id: string;
  name: string;
}

interface BrandAsset {
  id: string;
  name: string;
  url: string;
  filename: string;
}

const VideosPage: React.FC = () => {
  const { token } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [tasksWithExecutions, setTasksWithExecutions] = useState<Record<string, TaskWithExecutions>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<string>('latestExecution');
  const [executingTasks, setExecutingTasks] = useState<Set<string>>(new Set());
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [pendingArchiveVideo, setPendingArchiveVideo] = useState<{ executionId: string; videoUrl: string } | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoPreviewOpen, setVideoPreviewOpen] = useState(false);
  const [previewVideo, setPreviewVideo] = useState<{ url: string; filename: string; taskId: string; executionId: string } | null>(null);
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [isSubmittingRevision, setIsSubmittingRevision] = useState(false);

  // Handle escape key to close video preview
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && videoPreviewOpen) {
        setVideoPreviewOpen(false);
        setRevisionPrompt('');
      }
    };

    if (videoPreviewOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [videoPreviewOpen]);

  // Reset revision prompt when modal closes
  useEffect(() => {
    if (!videoPreviewOpen) {
      setRevisionPrompt('');
    }
  }, [videoPreviewOpen]);

  // Create task functionality
  const [createTaskDialogOpen, setCreateTaskDialogOpen] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [availableBrandGuidelines, setAvailableBrandGuidelines] = useState<BrandGuideline[]>([]);
  const [availableCompetitorBrandGuidelines, setAvailableCompetitorBrandGuidelines] = useState<BrandGuideline[]>([]);
  const [availableICPs, setAvailableICPs] = useState<ICPProfile[]>([]);
  const [availableBrandAssets, setAvailableBrandAssets] = useState<BrandAsset[]>([]);
  const [selectedOptions, setSelectedOptions] = useState<{
    brandGuidelines: string[];
    competitorBrandGuidelines: string[];
    icp: string[];
    brandAssets: string[];
    creativeTypes: string[];
  }>({
    brandGuidelines: [],
    competitorBrandGuidelines: [],
    icp: [],
    brandAssets: [],
    creativeTypes: []
  });
  const [quantity, setQuantity] = useState(3);
  const [additionalInstructions, setAdditionalInstructions] = useState('');

  const allTasks = Object.values(tasksWithExecutions);
  const totalExecutions = allTasks.reduce((sum, task) => sum + task.executions.length, 0);
  const totalVideos = allTasks.reduce((sum, task) => 
    sum + task.executions.reduce((execSum, exec) => 
      execSum + exec.result_files.filter(file => !file.is_archived).length, 0), 0);

  // Check if there are any active executions in the current view
  const hasActiveExecutionsInView = allTasks.some(task => 
    task.latestPendingOrRunningExecution !== null
  );

  // Auto-refresh when there are active executions
  useEffect(() => {
    if (hasActiveExecutionsInView) {
      const interval = setInterval(() => {
        fetchTasksWithExecutions();
      }, 5000); // Refresh every 5 seconds

      return () => clearInterval(interval);
    }
  }, [hasActiveExecutionsInView]);

  const fetchTasksWithExecutions = async () => {
    if (!token) return;

    try {
      const response = await axios.get(
        buildApiUrl('/api/tasks/executions/with-videos'),
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      setTasksWithExecutions(response.data);
      
      // Update executingTasks state based on current executions
      const currentlyExecuting = new Set<string>();
      Object.values(response.data).forEach((task: TaskWithExecutions) => {
        if (task.latestPendingOrRunningExecution) {
          currentlyExecuting.add(task.taskId);
        }
      });
      setExecutingTasks(currentlyExecuting);
      
    } catch (err: any) {
      console.error('Failed to fetch tasks with executions:', err);
      setError('Failed to load video data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasksWithExecutions();
  }, [token]);

  const handleGenerateMore = async (taskId: string) => {
    // Open feedback dialog first
    setPendingTaskId(taskId);
    setFeedbackText('');
    setFeedbackDialogOpen(true);
  };

  const handleUploadDirectly = (taskId: string) => {
    setPendingTaskId(taskId);
    setSelectedFile(null);
    setUploadDialogOpen(true);
  };

  const handleTaskExecution = async (taskId: string) => {
    if (!token) return;

    try {
      setExecutingTasks(prev => new Set(prev).add(taskId));
      
      await axios.post(
        buildApiUrl(`/api/tasks/${taskId}/execute`),
        {},
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      toast({
        title: "Task Executed",
        description: "Task execution started successfully.",
      });

      // Refresh the data to show the new execution
      fetchTasksWithExecutions();
    } catch (err: any) {
      console.error('Failed to execute task:', err);
      setExecutingTasks(prev => {
        const newSet = new Set(prev);
        newSet.delete(taskId);
        return newSet;
      });
      
      toast({
        title: "Execution Failed",
        description: err.response?.data?.message || "Failed to execute task.",
        variant: "destructive",
      });
    }
  };

  const handleSubmitFeedback = async () => {
    if (!pendingTaskId || !token) {
      toast({
        title: "Error",
        description: "Authentication token not found. Please log in.",
        variant: "destructive",
      });
      return;
    }

    setExecutingTasks(prev => new Set(prev).add(pendingTaskId));
    setFeedbackDialogOpen(false);
    
    try {
      await axios.post(
        buildApiUrl(`/api/tasks/${pendingTaskId}/execute`),
        { 
          feedback: feedbackText.trim() || undefined 
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      toast({ 
        title: "Success", 
        description: "Task execution started with your feedback. New videos will appear shortly." 
      });
      
      // Refresh the data after a short delay to show the new execution
      setTimeout(() => {
        fetchTasksWithExecutions();
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
        newSet.delete(pendingTaskId);
        return newSet;
      });
      setPendingTaskId(null);
      setFeedbackText('');
    }
  };

  const handleCancelFeedback = () => {
    setFeedbackDialogOpen(false);
    setPendingTaskId(null);
    setFeedbackText('');
  };

  const formatDate = (dateString: string | undefined) => {
    if (!dateString) return 'Unknown';
    try {
      return format(new Date(dateString), 'MMM dd, yyyy HH:mm');
    } catch {
      return 'Invalid date';
    }
  };

  const handleToggleFavorite = async (executionId: string, videoUrl: string) => {
    if (!token) return;

    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/executions/${executionId}/favorite-image`),
        { imageUrl: videoUrl },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.data.success) {
        // Update the specific video's favorite status in local state
        setTasksWithExecutions(prev => {
          const updated = { ...prev };
          Object.keys(updated).forEach(taskId => {
            const task = updated[taskId];
            task.executions = task.executions.map(execution => {
              if (execution.executionId === executionId) {
                return {
                  ...execution,
                  result_files: execution.result_files.map(file => {
                    if (file.url === videoUrl) {
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
          description: response.data.is_favorited ? "Video added to favorites." : "Video removed from favorites.",
        });
      }
    } catch (err: any) {
      console.error('Failed to toggle favorite:', err);
      toast({
        title: "Error",
        description: err.response?.data?.message || "Failed to update favorite status.",
        variant: "destructive",
      });
    }
  };

  const handleArchiveVideo = async () => {
    if (!pendingArchiveVideo) return;

    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/executions/${pendingArchiveVideo.executionId}/archive-image`),
        { imageUrl: pendingArchiveVideo.videoUrl },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.data.success) {
        // Update the specific video's archived status in local state
        setTasksWithExecutions(prev => {
          const updated = { ...prev };
          Object.keys(updated).forEach(taskId => {
            const task = updated[taskId];
            task.executions = task.executions.map(execution => {
              if (execution.executionId === pendingArchiveVideo.executionId) {
                return {
                  ...execution,
                  result_files: execution.result_files.map(file => {
                    if (file.url === pendingArchiveVideo.videoUrl) {
                      return {
                        ...file,
                        is_archived: true
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
          title: "Video Archived",
          description: "Video has been archived successfully.",
        });
      }

      setArchiveDialogOpen(false);
      setPendingArchiveVideo(null);
    } catch (err: any) {
      console.error('Failed to archive video:', err);
      toast({
        title: "Error",
        description: err.response?.data?.message || "Failed to archive video.",
        variant: "destructive",
      });
    }
  };

  const handleVideoUpload = async () => {
    if (!selectedFile || !token) return;

    // Validate file type - only .mp4 allowed
    if (!selectedFile.name.toLowerCase().endsWith('.mp4')) {
      toast({
        title: "Invalid File Type",
        description: "Only .mp4 video files are supported.",
        variant: "destructive",
      });
      return;
    }

    setUploadingVideo(true);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      // Find the first task to upload to (you might want to make this selectable)
      const firstTaskId = allTasks[0]?.taskId;
      if (!firstTaskId) {
        throw new Error('No tasks available to upload to');
      }

      await axios.post(
        buildApiUrl(`/api/tasks/${firstTaskId}/upload-image`),
        formData,
        {
          headers: { 
            Authorization: `Bearer ${token}`,
            'Content-Type': 'multipart/form-data'
          }
        }
      );

      toast({
        title: "Video Uploaded",
        description: "Video has been uploaded successfully.",
      });

      setUploadDialogOpen(false);
      setSelectedFile(null);
      
      // Refresh the data to show the new upload
      fetchTasksWithExecutions();
    } catch (err: any) {
      console.error('Failed to upload video:', err);
      toast({
        title: "Upload Failed",
        description: err.response?.data?.message || "Failed to upload video.",
        variant: "destructive",
      });
    } finally {
      setUploadingVideo(false);
    }
  };

  const handleCreateRevision = async () => {
    if (!previewVideo || !revisionPrompt.trim()) return;

    setIsSubmittingRevision(true);

    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/${previewVideo.taskId}/create-revision`),
        { 
          prompt: revisionPrompt,
          originalExecutionId: previewVideo.executionId 
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      toast({
        title: "Revision Task Created",
        description: "A new task has been created for your revision.",
      });

      setVideoPreviewOpen(false);
      setRevisionPrompt('');
      
      // Refresh the data
      fetchTasksWithExecutions();
    } catch (err: any) {
      console.error('Failed to create revision:', err);
      toast({
        title: "Error",
        description: err.response?.data?.message || "Failed to create revision task.",
        variant: "destructive",
      });
    } finally {
      setIsSubmittingRevision(false);
    }
  };

  // Filter and sort tasks
  const filteredTasks = allTasks.filter(task =>
    task.taskName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    task.taskId.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const sortedTasks = [...filteredTasks].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.taskName.localeCompare(b.taskName);
      case 'taskId':
        return a.taskId.localeCompare(b.taskId);
      case 'createdAt':
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case 'latestExecution':
      default:
        // Sort by latest execution time, with null values last
        const aTime = a.latestExecutionTime ? new Date(a.latestExecutionTime).getTime() : 0;
        const bTime = b.latestExecutionTime ? new Date(b.latestExecutionTime).getTime() : 0;
        return bTime - aTime;
    }
  });

  const loadTaskCreationData = async () => {
    if (!token) return;

    try {
      const [brandGuidelinesRes, competitorBrandGuidelinesRes, icpRes, brandAssetsRes] = await Promise.all([
        axios.get(buildApiUrl('/api/brand/guidelines'), {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get(buildApiUrl('/api/brand/competitor-guidelines'), {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get(buildApiUrl('/api/brand/icp'), {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get(buildApiUrl('/api/brand/assets'), {
          headers: { Authorization: `Bearer ${token}` }
        })
      ]);

      setAvailableBrandGuidelines(brandGuidelinesRes.data);
      setAvailableCompetitorBrandGuidelines(competitorBrandGuidelinesRes.data);
      setAvailableICPs(icpRes.data);
      setAvailableBrandAssets(brandAssetsRes.data);
    } catch (err: any) {
      console.error('Failed to load task creation data:', err);
      toast({
        title: "Error",
        description: "Failed to load creation options.",
        variant: "destructive",
      });
    }
  };

  const handleCreateAdVideoTask = async () => {
    if (!token) {
      toast({
        title: "Error",
        description: "You must be logged in to create tasks.",
        variant: "destructive",
      });
      return;
    }

    if (selectedOptions.brandGuidelines.length === 0) {
      toast({
        title: "Error",
        description: "Please select at least one brand guideline.",
        variant: "destructive",
      });
      return;
    }

    if (selectedOptions.icp.length === 0) {
      toast({
        title: "Error",
        description: "Please select at least one ICP profile.",
        variant: "destructive",
      });
      return;
    }

    setIsCreatingTask(true);

    try {
      const taskData: CreateTaskRequest = {
        brandGuidelineIds: selectedOptions.brandGuidelines,
        competitorBrandGuidelineIds: selectedOptions.competitorBrandGuidelines,
        icpIds: selectedOptions.icp,
        brandAssetIds: selectedOptions.brandAssets,
        creativeTypes: ['Video'], // Default to video for this page
        quantity,
        additionalInstructions: additionalInstructions.trim() || undefined
      };

      const response = await axios.post(
        buildApiUrl('/api/brand/create-ad-content-tasks'),
        taskData,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      toast({
        title: "Tasks Created Successfully",
        description: `Created ${response.data.tasksCreated} video generation tasks.`,
      });

      setCreateTaskDialogOpen(false);
      
      // Reset form
      setSelectedOptions({
        brandGuidelines: [],
        competitorBrandGuidelines: [],
        icp: [],
        brandAssets: [],
        creativeTypes: []
      });
      setQuantity(3);
      setAdditionalInstructions('');
      
      // Refresh the tasks list
      fetchTasksWithExecutions();
    } catch (err: any) {
      console.error('Failed to create ad video tasks:', err);
      toast({
        title: "Error Creating Tasks",
        description: err.response?.data?.message || "Could not create ad video tasks.",
        variant: "destructive",
      });
    } finally {
      setIsCreatingTask(false);
    }
  };

  const handleICPToggle = (icpId: string) => {
    setSelectedOptions(prev => ({
      ...prev,
      icp: prev.icp.includes(icpId)
        ? prev.icp.filter(id => id !== icpId)
        : [...prev.icp, icpId]
    }));
  };

  // Load data when create dialog opens
  useEffect(() => {
    if (createTaskDialogOpen && token) {
      loadTaskCreationData();
    }
  }, [createTaskDialogOpen, token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex items-center space-x-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>Loading videos...</span>
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Ad Videos</h1>
          <p className="text-gray-600 dark:text-gray-400">
            All ad videos generated by your tasks ({totalVideos} videos from {totalExecutions} executions across {allTasks.length} tasks)
            {hasActiveExecutionsInView && (
              <span className="ml-2 text-blue-600 dark:text-blue-400">
                • Auto-refreshing active executions
              </span>
            )}
          </p>
        </div>
        <Button onClick={() => setCreateTaskDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-2">
          <Plus className="h-4 w-4 mr-2" />
          Create Ad Videos
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
          <Play className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">No videos found</h3>
          <p className="text-gray-600 dark:text-gray-400 mb-6">Create your first task that generates videos to see them here.</p>
          <Button onClick={() => setCreateTaskDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create Ad Videos
          </Button>
        </div>
      ) : sortedTasks.length === 0 ? (
        <div className="text-center py-12">
          <Play className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">No videos match your search</h3>
          <p className="text-gray-600 dark:text-gray-400">Try adjusting your search terms.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {sortedTasks.map((task) => {
            const hasActiveExecution = task.latestPendingOrRunningExecution !== null;
            const isCurrentlyExecuting = executingTasks.has(task.taskId);
            const canGenerateMore = !hasActiveExecution && !isCurrentlyExecuting;
            
            return (
              <Card key={task.taskId} className="overflow-hidden">
                <CardHeader className="bg-gray-50 dark:bg-gray-800/50">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-lg font-semibold text-gray-900 dark:text-white">
                          {task.taskName}
                        </CardTitle>
                        <button 
                          onClick={() => navigate(`/tasks/${task.taskId}`)}
                          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                        >
                          <ArrowUpRight className="h-3 w-3" />
                          View Task
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                        <span>ID: {task.taskId}</span>
                        <span>•</span>
                        <span>Created: {format(new Date(task.createdAt), 'MMM d, yyyy')}</span>
                        <span>•</span>
                        <span>{task.executions.length} execution{task.executions.length !== 1 ? 's' : ''}</span>
                        {task.latestExecutionTime && (
                          <>
                            <span>•</span>
                            <span>Latest: {format(new Date(task.latestExecutionTime), 'MMM d, h:mm a')}</span>
                          </>
                        )}
                        {task.latestPendingOrRunningExecution && (
                          <>
                            <span>•</span>
                            <Badge variant={task.latestPendingOrRunningExecution.status === 'running' ? 'default' : 'secondary'}>
                              {task.latestPendingOrRunningExecution.status}
                            </Badge>
                          </>
                        )}
                      </div>
                      {hasActiveExecution && (
                        <div className="flex items-center gap-2 mt-1 text-sm text-blue-600 dark:text-blue-400">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>
                            Generating videos... Started: {format(new Date(task.latestPendingOrRunningExecution!.startTime), 'MMM d, h:mm a')}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
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
                                <ChevronDown className="h-4 w-4 ml-1" />
                              </>
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleGenerateMore(task.taskId)}>
                            <Play className="h-4 w-4 mr-2" />
                            Generate with agent
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleUploadDirectly(task.taskId)}>
                            <Upload className="h-4 w-4 mr-2" />
                            Upload directly
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {task.executions.flatMap((execution, executionIndex) => 
                      execution.result_files.filter(file => !file.is_archived).map((file, fileIndex) => (
                        <div key={`${execution.executionId}-${fileIndex}`} className="group relative">
                          <div 
                            className="aspect-video bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 cursor-pointer"
                            onClick={() => {
                              setPreviewVideo({
                                url: file.url,
                                filename: file.filename,
                                taskId: task.taskId,
                                executionId: execution.executionId
                              });
                              setVideoPreviewOpen(true);
                            }}
                            title="Click to preview video"
                          >
                            <video
                              src={file.url}
                              className="w-full h-full object-cover group-hover:opacity-75 transition-opacity"
                              preload="metadata"
                            />
                            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black bg-opacity-50 pointer-events-none">
                              <Play className="h-12 w-12 text-white" />
                            </div>
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
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(file.url, '_blank');
                                }}
                                title="Download Video"
                              >
                                <Download className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleToggleFavorite(execution.executionId, file.url);
                                }}
                                title={file.is_favorited ? "Remove from favorites" : "Add to favorites"}
                              >
                                <Heart className={`h-4 w-4 ${file.is_favorited ? 'fill-red-500 text-red-500' : 'text-gray-400'}`} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingArchiveVideo({ executionId: execution.executionId, videoUrl: file.url });
                                  setArchiveDialogOpen(true);
                                }}
                                title="Archive Video"
                              >
                                <Archive className="h-4 w-4" />
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

      {/* Feedback Dialog */}
      <Dialog open={feedbackDialogOpen} onOpenChange={setFeedbackDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate More Videos</DialogTitle>
            <DialogDescription>
              Provide feedback or instructions to generate more videos with improvements.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="feedback">Instructions for video generation</Label>
              <Textarea
                id="feedback"
                placeholder="Describe improvements or changes you'd like in the new videos..."
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelFeedback}>
              Cancel
            </Button>
            <Button onClick={handleSubmitFeedback} disabled={!feedbackText.trim()}>
              Generate Videos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive Confirmation Dialog */}
      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive Video</DialogTitle>
            <DialogDescription>
              Are you sure you want to archive this video? Archived videos won't be shown in the main view but can still be accessed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleArchiveVideo}>
              Archive Video
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Video</DialogTitle>
            <DialogDescription>
              Upload an .mp4 video file to add to your collection.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="video-upload">Select video file (.mp4 only)</Label>
              <Input
                id="video-upload"
                type="file"
                accept=".mp4"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              />
            </div>
            {selectedFile && (
              <div className="text-sm text-gray-600 dark:text-gray-400">
                Selected: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleVideoUpload} 
              disabled={!selectedFile || uploadingVideo}
            >
              {uploadingVideo ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload Video
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Ad Videos Dialog */}
      <Dialog open={createTaskDialogOpen} onOpenChange={setCreateTaskDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Ad Videos</DialogTitle>
            <DialogDescription>
              Generate custom video advertisements using your brand guidelines and ICP profiles.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            {/* Brand Guidelines */}
            <div>
              <Label className="text-base font-medium">Brand Guidelines *</Label>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">Select the brand guidelines to follow</p>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {availableBrandGuidelines.map((guideline) => (
                  <div key={guideline.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={`brand-${guideline.id}`}
                      checked={selectedOptions.brandGuidelines.includes(guideline.id)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedOptions(prev => ({
                            ...prev,
                            brandGuidelines: [...prev.brandGuidelines, guideline.id]
                          }));
                        } else {
                          setSelectedOptions(prev => ({
                            ...prev,
                            brandGuidelines: prev.brandGuidelines.filter(id => id !== guideline.id)
                          }));
                        }
                      }}
                    />
                    <label htmlFor={`brand-${guideline.id}`} className="text-sm font-medium cursor-pointer">
                      {guideline.name}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Competitor Brand Guidelines */}
            {availableCompetitorBrandGuidelines.length > 0 && (
              <div>
                <Label className="text-base font-medium">Competitor Analysis (Optional)</Label>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">Include competitor guidelines for differentiation</p>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {availableCompetitorBrandGuidelines.map((guideline) => (
                    <div key={guideline.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={`competitor-${guideline.id}`}
                        checked={selectedOptions.competitorBrandGuidelines.includes(guideline.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedOptions(prev => ({
                              ...prev,
                              competitorBrandGuidelines: [...prev.competitorBrandGuidelines, guideline.id]
                            }));
                          } else {
                            setSelectedOptions(prev => ({
                              ...prev,
                              competitorBrandGuidelines: prev.competitorBrandGuidelines.filter(id => id !== guideline.id)
                            }));
                          }
                        }}
                      />
                      <label htmlFor={`competitor-${guideline.id}`} className="text-sm font-medium cursor-pointer">
                        {guideline.name}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ICP Profiles */}
            <div>
              <Label className="text-base font-medium">Target Audience (ICP) *</Label>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">Select your ideal customer profiles to target</p>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {availableICPs.map((icp) => (
                  <div key={icp.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={`icp-${icp.id}`}
                      checked={selectedOptions.icp.includes(icp.id)}
                      onCheckedChange={() => handleICPToggle(icp.id)}
                    />
                    <label htmlFor={`icp-${icp.id}`} className="text-sm font-medium cursor-pointer">
                      {icp.name}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Brand Assets */}
            {availableBrandAssets.length > 0 && (
              <div>
                <Label className="text-base font-medium">Brand Assets (Optional)</Label>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">Include brand assets in the video</p>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {availableBrandAssets.map((asset) => (
                    <div key={asset.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={`asset-${asset.id}`}
                        checked={selectedOptions.brandAssets.includes(asset.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedOptions(prev => ({
                              ...prev,
                              brandAssets: [...prev.brandAssets, asset.id]
                            }));
                          } else {
                            setSelectedOptions(prev => ({
                              ...prev,
                              brandAssets: prev.brandAssets.filter(id => id !== asset.id)
                            }));
                          }
                        }}
                      />
                      <label htmlFor={`asset-${asset.id}`} className="text-sm font-medium cursor-pointer">
                        {asset.name}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quantity */}
            <div>
              <Label htmlFor="quantity" className="text-base font-medium">Number of Videos</Label>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">How many videos to generate</p>
              <Input
                id="quantity"
                type="number"
                min="1"
                max="10"
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
              />
            </div>

            {/* Additional Instructions */}
            <div>
              <Label htmlFor="additional-instructions" className="text-base font-medium">Additional Instructions (Optional)</Label>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">Any specific requirements or preferences</p>
              <Textarea
                id="additional-instructions"
                placeholder="e.g., Focus on product benefits, include testimonials, specific tone of voice..."
                value={additionalInstructions}
                onChange={(e) => setAdditionalInstructions(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateTaskDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreateAdVideoTask} 
              disabled={isCreatingTask || selectedOptions.brandGuidelines.length === 0 || selectedOptions.icp.length === 0}
            >
              {isCreatingTask ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-2" />
                  Create {quantity} Video{quantity !== 1 ? 's' : ''}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Video Preview Dialog */}
      <Dialog open={videoPreviewOpen} onOpenChange={setVideoPreviewOpen}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 overflow-auto">
          {previewVideo && (
            <div className="bg-white">
              {/* Header */}
              <div className="sticky top-0 bg-gray-900 border-b border-gray-600 p-4 pr-4 flex items-center justify-between z-10">
                <div className="text-white text-sm font-medium">
                  {previewVideo.filename}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
                    onClick={() => window.open(previewVideo.url, '_blank')}
                    title="Download Video"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
                    onClick={() => {
                      setVideoPreviewOpen(false);
                      setRevisionPrompt('');
                    }}
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Main content area - side by side */}
              <div className="flex">
                {/* Video - Left side */}
                <div className="flex-1 bg-black flex items-center justify-center min-h-[60vh]">
                  <video
                    src={previewVideo.url}
                    controls
                    className="max-w-full max-h-[80vh] object-contain"
                    autoPlay
                  />
                </div>

                {/* Revision Panel - Right side */}
                <div className="w-80 bg-gray-50 border-l border-gray-200 p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Create Revision</h3>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="revision-prompt" className="text-sm font-medium">
                        Revision Instructions
                      </Label>
                      <Textarea
                        id="revision-prompt"
                        placeholder="Describe what changes you'd like to make to this video..."
                        value={revisionPrompt}
                        onChange={(e) => setRevisionPrompt(e.target.value)}
                        rows={8}
                        className="mt-2"
                      />
                    </div>
                    <Button
                      onClick={handleCreateRevision}
                      disabled={!revisionPrompt.trim() || isSubmittingRevision}
                      className="w-full"
                    >
                      {isSubmittingRevision ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Creating Revision...
                        </>
                      ) : (
                        <>
                          <Plus className="h-4 w-4 mr-2" />
                          Create Revision Task
                        </>
                      )}
                    </Button>
                    <p className="text-xs text-gray-600">
                      This will create a new task to generate a revised version of this video based on your instructions.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default VideosPage;