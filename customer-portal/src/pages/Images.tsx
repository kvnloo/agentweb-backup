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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Search, Filter, Calendar, Image as ImageIcon, ExternalLink, Clock, ArrowUpRight, Play, Zap, Download, Heart, Plus, Archive } from 'lucide-react';
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

interface ICP {
  id: string;
  title: string;
  description: string;
  valueProposition: string;
}

interface MarketStrategyData {
  businessOverview: string;
  icp: ICP[];
}

interface BrandData {
  brandName: string;
  tagline: string;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  toneOfVoice: string;
  keyMessages: string[];
  brandValues: string[];
  targetAudience: string;
  brandPersonality: string;
}

interface BrandAsset {
  type: string;
  url: string;
  key: string;
  filename: string;
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
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [pendingArchiveImage, setPendingArchiveImage] = useState<{ executionId: string; imageUrl: string } | null>(null);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Ad Image task creation state
  const [createTaskDialogOpen, setCreateTaskDialogOpen] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [brandData, setBrandData] = useState<BrandData | null>(null);
  const [brandAssets, setBrandAssets] = useState<BrandAsset[]>([]);
  const [marketStrategyData, setMarketStrategyData] = useState<MarketStrategyData | null>(null);
  const [selectedOptions, setSelectedOptions] = useState({
    brandGuidelines: true,
    businessOverview: true,
    icp: [] as string[]
  });
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [taskName, setTaskName] = useState('');

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
    // Open feedback dialog first
    setPendingTaskId(taskId);
    setFeedbackText('');
    setFeedbackDialogOpen(true);
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
        description: "Task execution started with your feedback. New images will appear shortly." 
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

  const handleArchiveImage = async (executionId: string, imageUrl: string) => {
    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/executions/${executionId}/archive-image`),
        { imageUrl },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        // Update the specific image's archived status in local state
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
          title: "Image Archived",
          description: "Image has been archived and will no longer be visible. Contact AgentWeb support to restore it.",
        });
      }
    } catch (error: any) {
      console.error('Error archiving image:', error);
      toast({
        title: "Error",
        description: error.response?.data?.message || "Failed to archive image.",
        variant: "destructive",
      });
    }
  };

  const handleArchiveClick = (executionId: string, imageUrl: string) => {
    setPendingArchiveImage({ executionId, imageUrl });
    setArchiveDialogOpen(true);
  };

  const handleArchiveConfirm = async () => {
    if (pendingArchiveImage) {
      await handleArchiveImage(pendingArchiveImage.executionId, pendingArchiveImage.imageUrl);
      setArchiveDialogOpen(false);
      setPendingArchiveImage(null);
    }
  };

  const handleArchiveCancel = () => {
    setArchiveDialogOpen(false);
    setPendingArchiveImage(null);
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
    (total, task) => total + task.executions.reduce((taskTotal, execution) => 
      taskTotal + execution.result_files.filter(file => !file.is_archived).length, 0),
    0
  );

  const totalExecutions = allTasks.reduce(
    (total, task) => total + task.executions.length,
    0
  );

  const hasActiveExecutionsInView = allTasks.some(task => task.latestPendingOrRunningExecution !== null);

  // Load brand guidelines and market strategy data
  const loadTaskCreationData = async () => {
    try {
      // Load brand guidelines
      const brandResponse = await axios.get(buildApiUrl('/api/brand/guidelines'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      if (brandResponse.data.exists) {
        setBrandData(brandResponse.data.brandData);
        setBrandAssets(brandResponse.data.attachments || []);
      }

      // Load market strategy
      const marketResponse = await axios.get(buildApiUrl('/api/market-strategy'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      if (marketResponse.data.success) {
        setMarketStrategyData(marketResponse.data.data);
      }
    } catch (error) {
      console.error('Error loading task creation data:', error);
    }
  };

  const handleCreateAdImageTask = async () => {
    if (!token) {
      toast({
        title: "Error",
        description: "Authentication token not found. Please log in.",
        variant: "destructive",
      });
      return;
    }

    // Validate required fields
    if (!taskName.trim()) {
      toast({
        title: "Error",
        description: "Task name is required.",
        variant: "destructive",
      });
      return;
    }

    if (!additionalPrompt.trim()) {
      toast({
        title: "Error",
        description: "Image Prompt is required. Please describe what images you want to generate.",
        variant: "destructive",
      });
      return;
    }

    setIsCreatingTask(true);
    
          try {
        // Build the prompt based on selected options
        let prompt = "";
        
        // Add task description at the beginning
        if (additionalPrompt.trim()) {
          prompt += `Task:\n${additionalPrompt.trim()}\n\n`;
        }
        
        prompt += "Use download_image to download reference images and generate_image to create the result images. Valid size values for generate_image include \"1024x1024\", \"1536x1024\", \"1024x1536\", \"auto\". Valid quality values for generate_image include \"low\", \"medium\", \"high\", \"auto\".\n\n";
        
        if (selectedOptions.brandGuidelines && brandData) {
          const brandGuidelines = [];
          
          // Only include fields that have values
          if (brandData.brandName?.trim()) brandGuidelines.push(`- Brand Name: ${brandData.brandName}`);
          if (brandData.tagline?.trim()) brandGuidelines.push(`- Tagline: ${brandData.tagline}`);
          if (brandData.primaryColor?.trim()) brandGuidelines.push(`- Primary Color: ${brandData.primaryColor}`);
          if (brandData.secondaryColor?.trim()) brandGuidelines.push(`- Secondary Color: ${brandData.secondaryColor}`);
          if (brandData.fontFamily?.trim()) brandGuidelines.push(`- Font Family: ${brandData.fontFamily}`);
          if (brandData.toneOfVoice?.trim()) brandGuidelines.push(`- Tone of Voice: ${brandData.toneOfVoice}`);
          if (brandData.keyMessages?.length > 0) brandGuidelines.push(`- Key Messages: ${brandData.keyMessages.join(', ')}`);
          if (brandData.brandValues?.length > 0) brandGuidelines.push(`- Brand Values: ${brandData.brandValues.join(', ')}`);
          if (brandData.targetAudience?.trim()) brandGuidelines.push(`- Target Audience: ${brandData.targetAudience}`);
          if (brandData.brandPersonality?.trim()) brandGuidelines.push(`- Brand Personality: ${brandData.brandPersonality}`);
          
          // Add brand assets if available
          if (brandAssets.length > 0) {
            const logoAssets = brandAssets.filter(asset => asset.type === 'logo' || asset.type === 'secondaryLogo');
            if (logoAssets.length > 0) {
              brandGuidelines.push(`- Brand Logos: ${logoAssets.map(asset => asset.url).join(', ')}`);
            }
          }
          
          if (brandGuidelines.length > 0) {
            prompt += `Brand Guidelines:\n${brandGuidelines.join('\n')}\n\n`;
          }
        }
        
        if (selectedOptions.businessOverview && marketStrategyData?.businessOverview) {
          prompt += `Business Overview:\n${marketStrategyData.businessOverview}\n\n`;
        }
        
        // Handle Target Audience based on ICP selection
        if (selectedOptions.icp.length > 0 && marketStrategyData?.icp) {
          const selectedICPs = marketStrategyData.icp.filter(icp => selectedOptions.icp.includes(icp.id));
          if (selectedICPs.length > 0) {
            prompt += `Target Audience: ${selectedICPs.map(icp => icp.title).join(', ')}\n\n`;
          }
        } else {
          // General audience if no ICP selected
          prompt += `Target Audience: General audience\n\n`;
        }
        
        prompt += `Please create high-quality ad images that align with the above brand guidelines and target the specified audience. The images should be professional, engaging, and suitable for various marketing channels.`;

      // Create tasks based on ICP selection
      const tasksToCreate = [];
      
      if (selectedOptions.icp.length > 0 && marketStrategyData?.icp) {
        // Create a task for each selected ICP
        const selectedICPs = marketStrategyData.icp.filter(icp => selectedOptions.icp.includes(icp.id));
        for (const icp of selectedICPs) {
          const icpPrompt = prompt.replace(
            /Target Audience: General audience/,
            `Target Audience: ${icp.title} - ${icp.description} (Value Proposition: ${icp.valueProposition})`
          );
          
          tasksToCreate.push({
            name: `${taskName.trim()} - ${icp.title}`,
            prompt: icpPrompt,
            category: 'Creatives',
            description: `Ad image generation targeting ${icp.title} audience`
          });
        }
      } else {
        // Create a single task for general audience
        tasksToCreate.push({
          name: taskName.trim(),
          prompt: prompt,
          category: 'Creatives',
          description: 'Ad image generation for general audience'
        });
      }

      // Create all tasks
      const createdTasks = [];
      for (const taskData of tasksToCreate) {
        const response = await axios.post(
          buildApiUrl('/api/tasks'),
          taskData,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        createdTasks.push(response.data);
      }

      toast({
        title: "Tasks Created Successfully",
        description: `Created ${createdTasks.length} ad image generation task${createdTasks.length > 1 ? 's' : ''}. You will be redirected to the Tasks page.`,
      });

      setCreateTaskDialogOpen(false);
      setSelectedOptions({
        brandGuidelines: true,
        businessOverview: true,
        icp: []
      });
      setAdditionalPrompt('');
      setTaskName('');
      
      // Navigate to tasks page
      navigate('/tasks');
      
    } catch (err: any) {
      console.error('Failed to create ad image tasks:', err);
      toast({
        title: "Error Creating Tasks",
        description: err.response?.data?.message || "Could not create ad image tasks.",
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Ad Images</h1>
          <p className="text-gray-600 dark:text-gray-400">
            All ad images generated by your tasks ({totalImages} images from {totalExecutions} executions across {allTasks.length} tasks)
            {hasActiveExecutionsInView && (
              <span className="ml-2 text-blue-600 dark:text-blue-400">
                • Auto-refreshing every 5 seconds
              </span>
            )}
          </p>
        </div>
        <Button onClick={() => setCreateTaskDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-2">
          <Plus className="h-4 w-4 mr-2" />
          Create Ad Images
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
                      execution.result_files.filter(file => !file.is_archived).map((file, fileIndex) => (
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
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-800"
                                onClick={() => handleArchiveClick(execution.executionId, file.url)}
                                title="Archive Image"
                              >
                                <Archive className="h-4 w-4 text-gray-400 hover:text-orange-500" />
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
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Provide Feedback for Better Images</DialogTitle>
            <DialogDescription>
              Share your thoughts on how to improve the generated images. Your feedback will be used to enhance the AI's understanding and generate better results.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="feedback">Feedback (Optional)</Label>
              <Textarea
                id="feedback"
                placeholder="e.g., Make the images more vibrant, use different angles, add more details, change the style to be more realistic..."
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                className="min-h-[120px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelFeedback}>
              Cancel
            </Button>
            <Button onClick={handleSubmitFeedback}>
              Generate with Feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive Confirmation Dialog */}
      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Archive Image</DialogTitle>
            <DialogDescription>
              Are you sure you want to archive this image? Archived images will no longer be visible and you will need to contact AgentWeb support to restore them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleArchiveCancel}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleArchiveConfirm}>
              Archive Image
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ad Image Task Creation Dialog */}
      <Dialog open={createTaskDialogOpen} onOpenChange={setCreateTaskDialogOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Ad Image Task</DialogTitle>
            <DialogDescription>
              Configure your ad image generation task by selecting the information to include in the prompt.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6 py-4">
            {/* Task Name */}
            <div className="space-y-3">
              <Label htmlFor="taskName" className="text-sm font-medium">
                Task Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="taskName"
                placeholder="e.g., Product Launch Ad Images, Social Media Campaign"
                value={taskName}
                onChange={(e) => setTaskName(e.target.value)}
                required
              />
            </div>

            {/* Brand Guidelines */}
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="brandGuidelines"
                  checked={selectedOptions.brandGuidelines}
                  onCheckedChange={(checked) => 
                    setSelectedOptions(prev => ({ ...prev, brandGuidelines: checked as boolean }))
                  }
                />
                <Label htmlFor="brandGuidelines" className="text-sm font-medium">
                  Brand Guidelines
                </Label>
              </div>
              {selectedOptions.brandGuidelines && brandData && (
                <div className="ml-6 p-3 bg-gray-50 dark:bg-gray-800 rounded-md text-sm">
                  <p><strong>Brand:</strong> {brandData.brandName}</p>
                  <p><strong>Tagline:</strong> {brandData.tagline}</p>
                  <p><strong>Colors:</strong> {brandData.primaryColor}, {brandData.secondaryColor}</p>
                </div>
              )}
            </div>

            {/* Market Strategy */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Market Strategy</h3>
              
              {/* Business Overview */}
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="businessOverview"
                    checked={selectedOptions.businessOverview}
                    onCheckedChange={(checked) => 
                      setSelectedOptions(prev => ({ ...prev, businessOverview: checked as boolean }))
                    }
                  />
                  <Label htmlFor="businessOverview" className="text-sm">
                    Business Overview
                  </Label>
                </div>
                {selectedOptions.businessOverview && marketStrategyData?.businessOverview && (
                  <div className="ml-6 p-3 bg-gray-50 dark:bg-gray-800 rounded-md text-sm">
                    <p>{marketStrategyData.businessOverview.substring(0, 200)}...</p>
                  </div>
                )}
              </div>

              {/* ICP Selection */}
              <div className="space-y-2">
                <Label className="text-sm">Ideal Customer Profiles (ICP)</Label>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Select specific ICPs to target, or leave unselected for general audience
                </p>
                {marketStrategyData?.icp && marketStrategyData.icp.length > 0 ? (
                  <div className="ml-6 space-y-2">
                    {marketStrategyData.icp.map((icp) => (
                      <div key={icp.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`icp-${icp.id}`}
                          checked={selectedOptions.icp.includes(icp.id)}
                          onCheckedChange={() => handleICPToggle(icp.id)}
                        />
                        <Label htmlFor={`icp-${icp.id}`} className="text-sm">
                          {icp.title}
                        </Label>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="ml-6 p-3 bg-gray-50 dark:bg-gray-800 rounded-md text-sm">
                    <p className="text-gray-500 dark:text-gray-400">
                      No ICPs defined. Task will target general audience.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Image Prompt */}
            <div className="space-y-3">
              <Label htmlFor="additionalPrompt" className="text-sm font-medium">
                Image Prompt <span className="text-red-500">*</span>
              </Label>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Describe what images you want to generate. Include specific details about style, composition, or reference image URLs.
              </p>
              <Textarea
                id="additionalPrompt"
                placeholder="e.g., Create minimalist product shots with warm lighting, or include reference image: https://example.com/reference-image.jpg"
                value={additionalPrompt}
                onChange={(e) => setAdditionalPrompt(e.target.value)}
                className="min-h-[100px]"
                required
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateTaskDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreateAdImageTask}
              disabled={isCreatingTask}
            >
              {isCreatingTask ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Task'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ImagesPage; 