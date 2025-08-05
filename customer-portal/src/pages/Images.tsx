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
import { Loader2, Search, Filter, Calendar, Image as ImageIcon, ExternalLink, Clock, ArrowUpRight, Play, Zap, Download, Heart, Plus, Archive, Upload, ChevronDown, X, CheckCircle, MessageSquare, AlertTriangle, RefreshCw } from 'lucide-react';
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
  approval_status?: 'pending' | 'approved' | 'needs_changes' | null;
  slack_message_ts?: string | null;
  approval_channel?: string | null;
}

type AssetType = 'image' | 'video' | 'html' | 'text' | 'pdf' | 'other';

// Utility function to determine asset type from filename
const getAssetTypeFromFilename = (filename: string): AssetType => {
  const extension = filename.toLowerCase().split('.').pop() || '';
  
  // Image formats
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(extension)) {
    return 'image';
  }
  
  // Video formats
  if (['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'mpg', 'mpeg', 'ogv'].includes(extension)) {
    return 'video';
  }
  
  // HTML formats
  if (['html', 'htm'].includes(extension)) {
    return 'html';
  }
  
  // Text formats
  if (['txt', 'json', 'csv', 'xml', 'md', 'js', 'css', 'log', 'yml', 'yaml'].includes(extension)) {
    return 'text';
  }
  
  // PDF format
  if (extension === 'pdf') {
    return 'pdf';
  }
  
  // Default to other
  return 'other';
};

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
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; filename: string; taskId: string; executionId: string } | null>(null);
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [isSubmittingRevision, setIsSubmittingRevision] = useState(false);
  
  // Approval-related state
  const [channelSelectionOpen, setChannelSelectionOpen] = useState(false);
  const [pendingApprovalImage, setPendingApprovalImage] = useState<{ executionId: string; imageUrl: string; filename: string } | null>(null);
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string; displayName: string }>>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [sendingApproval, setSendingApproval] = useState(false);
  const [approvalData, setApprovalData] = useState<{ assets?: Record<string, any> }>({});
  const [revisionModalOpen, setRevisionModalOpen] = useState(false);
  const [revisionImage, setRevisionImage] = useState<{ executionId: string; assetUrl: string; filename: string; feedback: string; taskId: string } | null>(null);
  const [selectedRevisionImage, setSelectedRevisionImage] = useState<string | null>(null);
  const [submittingRevision, setSubmittingRevision] = useState(false);

  // Handle escape key to close image preview
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && imagePreviewOpen) {
        setImagePreviewOpen(false);
        setRevisionPrompt('');
      }
    };

    if (imagePreviewOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [imagePreviewOpen]);

  // Reset revision prompt when modal closes
  useEffect(() => {
    if (!imagePreviewOpen) {
      setRevisionPrompt('');
    }
  }, [imagePreviewOpen]);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [refreshingExecutions, setRefreshingExecutions] = useState<Set<string>>(new Set());

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

  // Efficient refresh function that only updates specific execution results
  // instead of refreshing the entire page data
  const refreshExecutionResults = async (taskId: string, executionId: string) => {
    try {
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      const updatedExecution = response.data;
      
      // Update the specific execution in the local state
      setTasksWithExecutions(prev => {
        const updated = { ...prev };
        if (updated[taskId]) {
          updated[taskId] = {
            ...updated[taskId],
            executions: updated[taskId].executions.map(execution => 
              execution.executionId === executionId 
                ? {
                    ...execution,
                    startTime: updatedExecution.startTime,
                    result_files: updatedExecution.result_files || [],
                    status: updatedExecution.status,
                    completedAt: updatedExecution.completedAt
                  }
                : execution
            )
          };
          
          // Update latest execution time if this is the latest execution
          const latestExecution = updated[taskId].executions
            .sort((a, b) => new Date(b.startTime || '').getTime() - new Date(a.startTime || '').getTime())[0];
          
          if (latestExecution && latestExecution.executionId === executionId) {
            updated[taskId].latestExecutionTime = latestExecution.startTime;
          }
        }
        return updated;
      });
      
      return updatedExecution;
    } catch (err: any) {
      console.error('Error refreshing execution results:', err);
      return null;
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
      // Get all active executions that need refreshing
      const activeExecutions: Array<{ taskId: string; executionId: string }> = [];
      
      Object.values(tasksWithExecutions).forEach(task => {
        if (task.latestPendingOrRunningExecution) {
          activeExecutions.push({
            taskId: task.taskId,
            executionId: task.latestPendingOrRunningExecution.executionId
          });
        }
      });
      
      // Refresh each active execution individually
      activeExecutions.forEach(async ({ taskId, executionId }) => {
        const updatedExecution = await refreshExecutionResults(taskId, executionId);
        
                 // If execution is no longer pending/running, refresh all data
         if (updatedExecution && !['pending', 'running'].includes(updatedExecution.status)) {
           setTimeout(() => {
             fetchExecutionsWithImages();
           }, 1000);
         }
      });
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
      
      // Track which executions are being refreshed
      const activeExecutionIds = new Set<string>();
      Object.values(tasksWithExecutions).forEach(task => {
        if (task.latestPendingOrRunningExecution) {
          activeExecutionIds.add(task.latestPendingOrRunningExecution.executionId);
        }
      });
      setRefreshingExecutions(activeExecutionIds);
    } else {
      stopAutoRefresh();
      setRefreshingExecutions(new Set());
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

  const handleUploadDirectly = (taskId: string) => {
    setPendingTaskId(taskId);
    setSelectedFile(null);
    setUploadDialogOpen(true);
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

  const handleViewImage = (imageUrl: string, filename: string, taskId: string, executionId: string) => {
    setPreviewImage({ url: imageUrl, filename, taskId, executionId });
    setImagePreviewOpen(true);
  };

  const handleSubmitRevision = async () => {
    if (!previewImage || !revisionPrompt.trim()) {
      toast({
        title: "Error",
        description: "Please enter a revision prompt.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmittingRevision(true);
    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/${previewImage.taskId}/executions/revision`),
        {
          revision_prompt: revisionPrompt.trim(),
          image_url: previewImage.url,
          original_execution_id: previewImage.executionId
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        toast({
          title: "Revision Submitted",
          description: "Your image revision request has been submitted. The new execution will start shortly.",
        });
        setImagePreviewOpen(false);
        setRevisionPrompt('');
        // Refresh the executions to show the new pending execution
        await fetchExecutionsWithImages();
      }
    } catch (error: any) {
      console.error('Error submitting revision:', error);
      toast({
        title: "Error",
        description: error.response?.data?.message || "Failed to submit revision request.",
        variant: "destructive",
      });
    } finally {
      setIsSubmittingRevision(false);
    }
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

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Check if file is an image
      if (!file.type.startsWith('image/')) {
        toast({
          title: "Error",
          description: "Please select an image file.",
          variant: "destructive",
        });
        return;
      }
      setSelectedFile(file);
    }
  };

  const handleUploadImage = async () => {
    if (!pendingTaskId || !selectedFile || !token) {
      toast({
        title: "Error",
        description: "Please select a file to upload.",
        variant: "destructive",
      });
      return;
    }

    setUploadingImage(true);
    
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      await axios.post(
        buildApiUrl(`/api/tasks/${pendingTaskId}/upload-file`),
        formData,
        {
          headers: { 
            Authorization: `Bearer ${token}`,
            'Content-Type': 'multipart/form-data'
          },
        }
      );
      
      toast({ 
        title: "Success", 
        description: "Image uploaded successfully and added to the latest execution." 
      });
      
      setUploadDialogOpen(false);
      setSelectedFile(null);
      setPendingTaskId(null);
      
      // Refresh the data to show the new image
      setTimeout(() => {
        // Try to refresh just the latest execution first
        const task = tasksWithExecutions[pendingTaskId];
        if (task && task.latestPendingOrRunningExecution) {
          refreshExecutionResults(pendingTaskId, task.latestPendingOrRunningExecution.executionId);
        } else {
          // Fallback to full refresh if no active execution
          fetchExecutionsWithImages();
        }
      }, 1000);
      
    } catch (err: any) {
      console.error('Failed to upload image:', err);
      toast({
        title: "Error Uploading Image",
        description: err.response?.data?.message || "Could not upload image.",
        variant: "destructive",
      });
    } finally {
      setUploadingImage(false);
    }
  };

  const handleUploadCancel = () => {
    setUploadDialogOpen(false);
    setSelectedFile(null);
    setPendingTaskId(null);
  };

  // Load approval data for all assets
  const loadApprovalData = async () => {
    try {
      const assetUrls = new Set<string>();
      Object.values(tasksWithExecutions).forEach(task => {
        task.executions.forEach(execution => {
          execution.result_files.forEach(file => {
            if (!file.is_archived) {
              assetUrls.add(file.url);
            }
          });
        });
      });

      if (assetUrls.size === 0) {
        setApprovalData({});
        return;
      }

      const response = await axios.post(buildApiUrl('/api/slack/approvals'), {
        assetUrls: Array.from(assetUrls)
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });

      setApprovalData({ assets: response.data.approvals || {} });
    } catch (error) {
      console.error('Error loading approval data:', error);
    }
  };

  // Load approval data when tasks change
  useEffect(() => {
    if (Object.keys(tasksWithExecutions).length > 0 && token) {
      loadApprovalData();
    }
  }, [tasksWithExecutions, token]);

  // Manual refresh function removed - real-time webhook updates handle this automatically

  // Real-time updates handled by Slack webhooks - no polling needed

  // Approval handlers
  const handleApprovalClick = async (executionId: string, assetUrl: string, filename: string) => {
    setPendingApprovalImage({ executionId, imageUrl: assetUrl, filename });
    setChannelSelectionOpen(true);
    
    // Load Slack channels
    if (slackChannels.length === 0) {
      await loadSlackChannels();
    }
  };

  const loadSlackChannels = async () => {
    setLoadingChannels(true);
    try {
      const response = await axios.get(buildApiUrl('/api/slack/channels'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSlackChannels(response.data);
    } catch (error: any) {
      console.error('Error loading Slack channels:', error);
      toast({
        title: "Error Loading Channels",
        description: "Could not load Slack channels. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoadingChannels(false);
    }
  };

  const handleSendApprovalRequest = async (channelId: string) => {
    if (!pendingApprovalImage || !token) return;

    setSendingApproval(true);
    try {
      const assetType = getAssetTypeFromFilename(pendingApprovalImage.filename);
      
      // Find the channel name from the selected channel ID
      const selectedChannel = slackChannels.find(ch => ch.id === channelId);
      const channelName = selectedChannel?.name || channelId;
      
      const response = await axios.post(
        buildApiUrl('/api/slack/send-approval'),
        {
          channel: channelId,
          channelName: channelName,
          assetUrl: pendingApprovalImage.imageUrl,
          filename: pendingApprovalImage.filename,
          assetType,
          executionId: pendingApprovalImage.executionId,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        toast({
          title: "Approval Request Sent",
          description: "The approval request has been sent to Slack successfully.",
        });
        
        setChannelSelectionOpen(false);
        setPendingApprovalImage(null);
        
        // Use timeout approach like emma-dashboard for immediate feedback
        setTimeout(async () => {
          await loadApprovalData();
        }, 1000);
      }
    } catch (error: any) {
      console.error('Error sending approval request:', error);
      toast({
        title: "Error Sending Approval",
        description: error.response?.data?.message || "Failed to send approval request.",
        variant: "destructive",
      });
    } finally {
      setSendingApproval(false);
    }
  };

  const handleCancelApproval = () => {
    setChannelSelectionOpen(false);
    setPendingApprovalImage(null);
  };

  const handleRevisionClick = (executionId: string, assetUrl: string, filename: string, feedback: string, taskId: string) => {
    setRevisionImage({ executionId, assetUrl, filename, feedback, taskId });
    setSelectedRevisionImage(null);
    setRevisionModalOpen(true);
  };

  // Get all unreviewed alternative images from the task in a single flat array
  const getUnreviewedAlternativeImages = () => {
    if (!revisionImage?.taskId || !tasksWithExecutions[revisionImage.taskId]) {
      return [];
    }
    
    const allFiles = [];
    for (const execution of tasksWithExecutions[revisionImage.taskId].executions) {
      for (const file of execution.result_files) {
        if (!file.is_archived && file.url !== revisionImage.assetUrl) {
          const approval = getApprovalStatus(file.url);
          const isUnreviewed = !approval || (approval.status !== 'pending' && approval.status !== 'approved' && approval.status !== 'needs_changes' && approval.status !== 'revision_submitted');
          
          // Only include unreviewed images
          if (isUnreviewed) {
            allFiles.push(file);
          }
        }
      }
    }
    return allFiles;
  };

  const handleRevisionImageSelect = (assetUrl: string) => {
    setSelectedRevisionImage(assetUrl);
  };

  const handleSubmitApprovalRevision = async () => {
    if (!revisionImage || !selectedRevisionImage || !token) return;

    setSubmittingRevision(true);
    try {
      const response = await axios.post(
        buildApiUrl('/api/slack/submit-revision'),
        {
          executionId: revisionImage.executionId,
          originalAssetUrl: revisionImage.assetUrl,
          originalFilename: revisionImage.filename,
          selectedAssetUrl: selectedRevisionImage,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        toast({
          title: "Revision Submitted",
          description: "Your revision has been submitted for review.",
        });
        
        setRevisionModalOpen(false);
        setRevisionImage(null);
        setSelectedRevisionImage(null);
        
        // Refresh approval data to show updated status
        setTimeout(async () => {
          await loadApprovalData();
        }, 1000);
      }
    } catch (error: any) {
      console.error('Error submitting revision:', error);
      toast({
        title: "Error Submitting Revision",
        description: error.response?.data?.message || "Failed to submit revision.",
        variant: "destructive",
      });
    } finally {
      setSubmittingRevision(false);
    }
  };

  const handleCancelRevision = () => {
    setRevisionModalOpen(false);
    setRevisionImage(null);
    setSelectedRevisionImage(null);
  };

  // Get approval status for a specific asset
  const getApprovalStatus = (assetUrl: string) => {
    return approvalData.assets?.[assetUrl] || null;
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
        let prompt = "Please create high-quality ad images that align with the below context and target the specified audience. The images should be professional, engaging, and suitable for various marketing channels. Use download_image to download reference images and generate_image to create the result images. Valid size values for generate_image include \"1024x1024\", \"1536x1024\", \"1024x1536\", \"auto\". Valid quality values for generate_image include \"low\", \"medium\", \"high\", \"auto\". DO NOT browse the internet for other images.\n\n";
        
        // Add task description
        if (additionalPrompt.trim()) {
          prompt += `Image Prompt:\n${additionalPrompt.trim()}\n\n`;
        }
        
        if (selectedOptions.brandGuidelines && brandData) {
          prompt += `Brand Guidelines:\nIMPORTANT: Use the following brand data including logo, typography, brand colors, and other brand elements to maintain consistency in generated images. Ensure all images align with the brand identity.\n\n`;
          
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
            prompt += `${brandGuidelines.join('\n')}\n\n`;
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
                • Auto-refreshing active executions
              </span>
            )}
            
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setCreateTaskDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-2">
            <Plus className="h-4 w-4 mr-2" />
            Create Ad Images
          </Button>
        </div>
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
                          <span>
                            Generating images... Started: {formatDate(task.latestPendingOrRunningExecution!.startTime)}
                            {refreshingExecutions.has(task.latestPendingOrRunningExecution!.executionId) && (
                              <span className="ml-2 text-xs">• Auto-refreshing</span>
                            )}
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
                            className="aspect-square overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer"
                            onClick={() => handleViewImage(file.url, file.filename, task.taskId, execution.executionId)}
                            title="Click to preview image"
                          >
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
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(file.url, '_blank');
                                }}
                                title="Download Image"
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
                              {(() => {
                                const approval = getApprovalStatus(file.url);
                                const status = approval?.status;
                                
                                // Create detailed tooltip based on status
                                let tooltip = '';
                                if (status === 'approved') {
                                  const approvedTime = approval?.updatedAt ? new Date(approval.updatedAt).toLocaleString() : 'Unknown time';
                                  const feedback = approval?.feedback ? `\nFeedback: ${approval.feedback}` : '';
                                  tooltip = `Approved by ${approval?.reviewedBy || 'Unknown'} at ${approvedTime}${feedback}`;
                                } else if (status === 'needs_changes') {
                                  const changedTime = approval?.updatedAt ? new Date(approval.updatedAt).toLocaleString() : 'Unknown time';
                                  const feedback = approval?.feedback ? `\nFeedback: ${approval.feedback}` : '';
                                  tooltip = `Changes requested by ${approval?.reviewedBy || 'Unknown'} at ${changedTime}${feedback}`;
                                } else if (status === 'pending') {
                                  const sentTime = approval?.createdAt ? new Date(approval.createdAt).toLocaleString() : 'Unknown time';
                                  const channel = approval?.slackChannelName ? `#${approval.slackChannelName}` : (approval?.slackChannel ? approval.slackChannel : 'Unknown channel');
                                  tooltip = `Review request sent at ${sentTime} to channel ${channel}`;
                                } else if (status === 'revision_submitted') {
                                  const submittedTime = approval?.updatedAt ? new Date(approval.updatedAt).toLocaleString() : 'Unknown time';
                                  tooltip = `Revision submitted at ${submittedTime}`;
                                } else {
                                  tooltip = 'Request Approval';
                                }
                                
                                                                  return (
                                    <div className="relative">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-800"
                                        onClick={
                                          status === 'pending' 
                                            ? undefined 
                                            : status === 'needs_changes'
                                              ? () => handleRevisionClick(execution.executionId, file.url, file.filename, approval?.feedback || '', task.taskId)
                                              : () => handleApprovalClick(execution.executionId, file.url, file.filename)
                                        }
                                        title={tooltip}
                                      >
                                    {status === 'approved' ? (
                                      <CheckCircle className="h-4 w-4 text-green-500" />
                                    ) : status === 'needs_changes' ? (
                                      <AlertTriangle className="h-4 w-4 text-orange-500" />
                                    ) : status === 'pending' ? (
                                      <MessageSquare className="h-4 w-4 text-blue-500" />
                                    ) : status === 'revision_submitted' ? (
                                      <RefreshCw className="h-4 w-4 text-purple-500" />
                                    ) : (
                                      <MessageSquare className="h-4 w-4 text-gray-400 hover:text-blue-500" />
                                    )}
                                    {approval?.feedback && (
                                      <div className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" title="Has feedback"></div>
                                    )}
                                      </Button>
                                    </div>
                                  );
                                })()}
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
            <DialogTitle>Provide Feedback for Agent</DialogTitle>
            <DialogDescription>
              Share your thoughts on how to improve the generated images. Your feedback will be used to enhance the AI agent's understanding and generate better results.
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

      {/* Upload Image Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Upload Image Directly</DialogTitle>
            <DialogDescription>
              Upload an image file to add it to the latest execution of this task. The image will be stored in S3 and appear alongside other generated images.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="imageFile">Select Image File</Label>
              <Input
                id="imageFile"
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="cursor-pointer"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Supported formats: JPG, PNG, GIF, WebP, SVG (max 5MB)
              </p>
            </div>
            {selectedFile && (
              <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
                <p className="text-sm font-medium">Selected file:</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">{selectedFile.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Size: {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleUploadCancel}>
              Cancel
            </Button>
            <Button 
              onClick={handleUploadImage}
              disabled={!selectedFile || uploadingImage}
            >
              {uploadingImage ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload Image
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image Preview Dialog */}
      <Dialog open={imagePreviewOpen} onOpenChange={setImagePreviewOpen}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 overflow-auto">
          {previewImage && (
            <div className="bg-white">
              {/* Header */}
              <div className="sticky top-0 bg-gray-900 border-b border-gray-600 p-4 pr-4 flex items-center justify-between z-10">
                <div className="text-white text-sm font-medium">
                  {previewImage.filename}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
                    onClick={() => window.open(previewImage.url, '_blank')}
                    title="Download Image"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
                    onClick={() => {
                      setImagePreviewOpen(false);
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
                {/* Image - Left side */}
                <div className="flex-1 bg-black p-4">
                  <img
                    src={previewImage.url}
                    alt={previewImage.filename}
                    className="w-full h-auto"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgdmlld0JveD0iMCAwIDIwMCAyMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIiBmaWxsPSIjRjNGNEY2Ii8+CjxwYXRoIGQ9Ik02MCAxMDBDNjAgODguOTU0MyA2OC45NTQzIDgwIDgwIDgwQzkxLjA0NTcgODAgMTAwIDg4Ljk1NDMgMTAwIDEwMEMxMDAgMTExLjA0NiA5MS4wNDU3IDEyMCA4MCAxMjBDNjguOTU0MyAxMjAgNjAgMTExLjA0NiA2MCAxMDBaIiBmaWxsPSIjOUI5QkEwIi8+CjxwYXRoIGQ9Ik04MCAxNDBDNjguOTU0MyAxNDAgNjAgMTMxLjA0NiA2MCAxMjBMMTAwIDEyMEMxMDAgMTMxLjA0NiA5MS4wNDU3IDE0MCA4MCAxNDBaIiBmaWxsPSIjOUI5QkEwIi8+Cjwvc3ZnPgo=';
                    }}
                  />
                </div>

                {/* Revision Prompt Section - Right side */}
                <div className="w-80 bg-gray-900 border-l border-gray-600 p-4 flex flex-col">
                  <div className="flex-1">
                    <Label htmlFor="revisionPrompt" className="text-white text-sm font-medium mb-3 block">
                      Image Revision Prompt
                    </Label>
                    <Textarea
                      id="revisionPrompt"
                      placeholder="Describe how you'd like to revise this image (e.g., 'Make it more vibrant', 'Change the background to blue', 'Add more details')"
                      value={revisionPrompt}
                      onChange={(e) => setRevisionPrompt(e.target.value)}
                      className="min-h-[120px] bg-gray-800 border-gray-600 text-white placeholder-gray-400 resize-none mb-4 w-full"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSubmitRevision();
                      }}
                      disabled={!revisionPrompt.trim() || isSubmittingRevision}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2"
                    >
                      {isSubmittingRevision ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Submitting...
                        </>
                      ) : (
                        <>
                          <Zap className="h-4 w-4 mr-2" />
                          Submit Revision
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Channel Selection Dialog */}
      <Dialog open={channelSelectionOpen} onOpenChange={setChannelSelectionOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Select Slack Channel</DialogTitle>
            <DialogDescription>
              Choose which Slack channel to send the approval request for: {pendingApprovalImage?.filename}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {loadingChannels ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span>Loading channels...</span>
              </div>
            ) : slackChannels.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-500 dark:text-gray-400">
                  No Slack channels available. Please check your Slack integration setup.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {slackChannels.map((channel) => (
                  <Button
                    key={channel.id}
                    variant="outline"
                    className="w-full justify-start h-auto p-3"
                    onClick={() => handleSendApprovalRequest(channel.id)}
                    disabled={sendingApproval}
                  >
                    <div className="flex items-center">
                      <MessageSquare className="h-4 w-4 mr-2" />
                      <span>{channel.displayName}</span>
                    </div>
                  </Button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelApproval} disabled={sendingApproval}>
              Cancel
            </Button>
            {sendingApproval && (
              <Button disabled>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Sending...
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revision Modal */}
      <Dialog open={revisionModalOpen} onOpenChange={setRevisionModalOpen}>
        <DialogContent className="sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Submit Revision</DialogTitle>
            <DialogDescription>
              Please select an existing image from this task to submit as a revision based on the feedback provided.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {revisionImage && (
              <>
                <div className="space-y-2">
                  <Label>Original Image (Needs Changes)</Label>
                  <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-800">
                    <img 
                      src={revisionImage.assetUrl} 
                      alt={revisionImage.filename}
                      className="max-w-full h-auto max-h-48 object-contain"
                    />
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                      {revisionImage.filename}
                    </p>
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label>Feedback</Label>
                  <div className="border rounded-lg p-4 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800">
                    <p className="text-sm text-yellow-800 dark:text-yellow-200">
                      {revisionImage.feedback || 'No specific feedback provided'}
                    </p>
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label>Select Alternative Image</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-80 overflow-y-auto">
                    {revisionImage.taskId && tasksWithExecutions[revisionImage.taskId]?.executions.flatMap((execution, executionIndex) => 
                      execution.result_files
                        .filter(file => {
                          if (file.is_archived || file.url === revisionImage.assetUrl) return false;
                          const approval = getApprovalStatus(file.url);
                          return !approval || (approval.status !== 'pending' && approval.status !== 'approved' && approval.status !== 'needs_changes' && approval.status !== 'revision_submitted');
                        })
                        .map((file, fileIndex) => (
                          <div 
                            key={`${execution.executionId}-${fileIndex}`}
                            className={`group relative aspect-square overflow-hidden rounded-lg border cursor-pointer transition-colors ${
                              selectedRevisionImage === file.url 
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' 
                                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                            }`}
                            onClick={() => handleRevisionImageSelect(file.url)}
                          >
                            <img 
                              src={file.url} 
                              alt={file.filename}
                              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                            />
                            {selectedRevisionImage === file.url && (
                              <div className="absolute top-2 left-2 bg-blue-500 text-white text-xs px-2 py-1 rounded">
                                Selected
                              </div>
                            )}
                            <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs p-2">
                              <p className="truncate">{file.filename}</p>
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Select an unreviewed image from this task to submit as a revision.
                  </p>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelRevision} disabled={submittingRevision}>
              Cancel
            </Button>
            <Button 
              onClick={handleSubmitApprovalRevision} 
              disabled={!selectedRevisionImage || submittingRevision}
            >
              {submittingRevision ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                'Submit Revision'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ImagesPage; 