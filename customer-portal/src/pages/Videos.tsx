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
import { Loader2, Search, Filter, Calendar, Play, ExternalLink, Clock, ArrowUpRight, Zap, Download, Heart, Plus, Archive, Upload, ChevronDown, X, CheckCircle, MessageSquare, AlertTriangle, Send } from 'lucide-react';
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
  approval_status?: string;
  slack_message_ts?: string;
  approval_channel?: string;
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

// Define asset type for API calls
type AssetType = 'image' | 'video' | 'document';

// Utility function to determine asset type from filename
const getAssetTypeFromFilename = (filename: string): AssetType => {
  const extension = filename.toLowerCase().split('.').pop();
  switch (extension) {
    case 'mp4':
    case 'avi':
    case 'mov':
    case 'wmv':
    case 'flv':
    case 'webm':
    case 'mkv':
      return 'video';
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'bmp':
    case 'svg':
    case 'webp':
      return 'image';
    default:
      return 'document';
  }
};

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
  
  // Approval-related state
  const [channelSelectionOpen, setChannelSelectionOpen] = useState(false);
  const [pendingApprovalVideo, setPendingApprovalVideo] = useState<{ executionId: string; videoUrl: string; filename: string } | null>(null);
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string; displayName: string }>>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [sendingApproval, setSendingApproval] = useState(false);
  const [approvalNote, setApprovalNote] = useState('');
  const [approvalData, setApprovalData] = useState<{ assets?: Record<string, any> }>({});
  const [revisionModalOpen, setRevisionModalOpen] = useState(false);
  const [revisionVideo, setRevisionVideo] = useState<{ executionId: string; url: string; filename: string; feedback: string; taskId: string; note?: string } | null>(null);
  const [selectedRevisionVideo, setSelectedRevisionVideo] = useState<string | null>(null);
  const [submittingRevision, setSubmittingRevision] = useState(false);
  const [revisionNote, setRevisionNote] = useState('');

  // Handle escape key to close video preview
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && videoPreviewOpen) {
        setVideoPreviewOpen(false);
      }
    };

    if (videoPreviewOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [videoPreviewOpen]);

  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [refreshingExecutions, setRefreshingExecutions] = useState<Set<string>>(new Set());

  // Ad Video task creation state
  const [createTaskDialogOpen, setCreateTaskDialogOpen] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [brandData, setBrandData] = useState<BrandData | null>(null);
  const [brandAssets, setBrandAssets] = useState<BrandAsset[]>([]);
  const [marketStrategyData, setMarketStrategyData] = useState<MarketStrategyData | null>(null);
  const [selectedOptions, setSelectedOptions] = useState({
    brandGuidelines: false,
    businessOverview: false,
    icp: [] as string[]
  });
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [taskName, setTaskName] = useState('');


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
      setTimeout(async () => {
        await fetchTasksWithExecutions();
        // Clear the executing state after the data refresh
        setExecutingTasks(prev => {
          const newSet = new Set(prev);
          newSet.delete(pendingTaskId);
          return newSet;
        });
        setPendingTaskId(null);
        setFeedbackText('');
      }, 2000);
      
    } catch (err: any) {
      console.error('Failed to execute task:', err);
      toast({
        title: "Error Executing Task",
        description: err.response?.data?.message || "Could not start task execution.",
        variant: "destructive",
      });
      // Clear the executing state on error
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
        buildApiUrl(`/api/tasks/${firstTaskId}/upload-file`),
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

  const handleUploadCancel = () => {
    setUploadDialogOpen(false);
    setSelectedFile(null);
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

  const handleCreateAdVideoTask = async () => {
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
        description: "Video Prompt is required. Please describe what videos you want to generate.",
        variant: "destructive",
      });
      return;
    }

    setIsCreatingTask(true);
    
    try {
      // Build the prompt based on selected options
      let prompt = "Please create a high-quality ad video that align with the below context and target the specified audience. The video should be professional, engaging, and suitable for various marketing channels. Use download_image to download reference images and generate_short_video to create the result video. DO NOT browse the internet for other videos.\n\n";
      
      // Add task description
      if (additionalPrompt.trim()) {
        prompt += `Video Prompt:\n${additionalPrompt.trim()}\n\n`;
      }
      
      if (selectedOptions.brandGuidelines && brandData) {
        prompt += `Brand Guidelines:\nIMPORTANT: Use the following brand data including logo, typography, brand colors, and other brand elements to maintain consistency in generated videos. Ensure all videos align with the brand identity.\n\n`;
        
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
            description: `Ad video generation targeting ${icp.title} audience`,
            createVideo: true,
            videoModel: 'gen4_turbo'
          });
        }
      } else {
        // Create a single task for general audience
        tasksToCreate.push({
          name: taskName.trim(),
          prompt: prompt,
          category: 'Creatives',
          description: 'Ad video generation for general audience',
          createVideo: true,
          videoModel: 'gen4_turbo'
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
        description: `Created ${createdTasks.length} ad video generation task${createdTasks.length > 1 ? 's' : ''}. You will be redirected to the Tasks page.`,
      });

      setCreateTaskDialogOpen(false);
      setSelectedOptions({
        brandGuidelines: false,
        businessOverview: false,
        icp: []
      });
      setAdditionalPrompt('');
      setTaskName('');
      
      // Navigate to tasks page
      navigate('/tasks');
      
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

  // Load data when create dialog opens
  useEffect(() => {
    if (createTaskDialogOpen && token) {
      loadTaskCreationData();
    }
  }, [createTaskDialogOpen, token]);

  // Approval-related functions
  const loadApprovalData = async () => {
    if (!token) return;
    
    try {
      const allUrls = Object.values(tasksWithExecutions).flatMap(task => 
        task.executions.flatMap(execution => 
          execution.result_files.map(file => file.url)
        )
      );
      
      if (allUrls.length === 0) {
        setApprovalData({});
        return;
      }

      const response = await axios.post(
        buildApiUrl('/api/slack/approvals'),
        { assetUrls: allUrls },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      setApprovalData({ assets: response.data.approvals || {} });
    } catch (error: any) {
      console.error('Error loading approval data:', error);
    }
  };

  const loadSlackChannels = async () => {
    if (!token) return;
    
    setLoadingChannels(true);
    try {
      const response = await axios.get(
        buildApiUrl('/api/slack/channels'),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSlackChannels(response.data);
    } catch (error: any) {
      console.error('Error loading Slack channels:', error);
      toast({
        title: "Error Loading Channels",
        description: "Failed to load Slack channels. Please check your integration setup.",
        variant: "destructive",
      });
    } finally {
      setLoadingChannels(false);
    }
  };

  const handleApprovalClick = async (executionId: string, videoUrl: string, filename: string) => {
    setPendingApprovalVideo({ executionId, videoUrl, filename });
    if (slackChannels.length === 0) {
      await loadSlackChannels();
    }
    setChannelSelectionOpen(true);
  };

  const handleSendApprovalRequest = async (channelId: string) => {
    if (!pendingApprovalVideo || !token) return;

    setSendingApproval(true);
    try {
      const assetType = getAssetTypeFromFilename(pendingApprovalVideo.filename);
      
      const selectedChannel = slackChannels.find(ch => ch.id === channelId);
      const channelName = selectedChannel?.displayName || selectedChannel?.name || 'Unknown Channel';

      const response = await axios.post(
        buildApiUrl('/api/slack/send-approval'),
        {
          channel: channelId,
          channelName,
          assetUrl: pendingApprovalVideo.videoUrl,
          filename: pendingApprovalVideo.filename,
          assetType,
          executionId: pendingApprovalVideo.executionId,
          note: approvalNote,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      setChannelSelectionOpen(false);
      setPendingApprovalVideo(null);
      setApprovalNote('');
      
      toast({
        title: "Approval Request Sent",
        description: `Approval request sent to ${channelName}`,
      });

      await loadApprovalData();
    } catch (error: any) {
      console.error('Error sending approval request:', error);
      toast({
        title: "Error",
        description: error.response?.data?.message || "Failed to send approval request.",
        variant: "destructive",
      });
    } finally {
      setSendingApproval(false);
    }
  };

  const handleCancelApproval = () => {
    setChannelSelectionOpen(false);
    setPendingApprovalVideo(null);
    setApprovalNote('');
  };

  const getApprovalStatus = (assetUrl: string) => {
    return approvalData.assets?.[assetUrl] || null;
  };

  const handleRevisionClick = (executionId: string, assetUrl: string, filename: string, feedback: string, taskId: string, note?: string) => {
    setRevisionVideo({ executionId, url: assetUrl, filename, feedback, taskId, note });
    setSelectedRevisionVideo(null);
    setRevisionNote(note || ''); // Copy the original note
    setRevisionModalOpen(true);
  };

  // Get all unreviewed alternative videos from the task in a single flat array
  const getUnreviewedAlternativeVideos = () => {
    if (!revisionVideo?.taskId || !tasksWithExecutions[revisionVideo.taskId]) {
      return [];
    }
    
    const allFiles = [];
    for (const execution of tasksWithExecutions[revisionVideo.taskId].executions) {
      for (const file of execution.result_files) {
        if (!file.is_archived && file.url !== revisionVideo.url) {
          const approval = getApprovalStatus(file.url);
          const isUnreviewed = !approval || (approval.status !== 'pending' && approval.status !== 'approved' && approval.status !== 'needs_changes' && approval.status !== 'revision_submitted');
          
          // Only include unreviewed videos
          if (isUnreviewed) {
            allFiles.push(file);
          }
        }
      }
    }
    return allFiles;
  };

  const handleRevisionVideoSelect = (assetUrl: string) => {
    setSelectedRevisionVideo(assetUrl);
  };

  const handleSubmitApprovalRevision = async () => {
    if (!revisionVideo || !selectedRevisionVideo || !token) return;

    setSubmittingRevision(true);
    try {
      const response = await axios.post(
        buildApiUrl('/api/slack/submit-revision'),
        {
          executionId: revisionVideo.executionId,
          originalAssetUrl: revisionVideo.url,
          originalFilename: revisionVideo.filename,
          selectedAssetUrl: selectedRevisionVideo,
          note: revisionNote.trim() || undefined, // Include updated note
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
        setRevisionVideo(null);
        setSelectedRevisionVideo(null);
        setRevisionNote(''); // Reset note after successful submission
        
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
    setRevisionVideo(null);
    setSelectedRevisionVideo(null);
    setRevisionNote(''); // Reset note when canceling
  };

  // Load approval data when tasks data changes
  useEffect(() => {
    if (Object.keys(tasksWithExecutions).length > 0) {
      loadApprovalData();
    }
  }, [tasksWithExecutions, token]);

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
                            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black bg-opacity-30 pointer-events-none">
                              <Play className="h-8 w-8 text-white" />
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
                              
                              {/* Approval Button */}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 relative"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const approval = getApprovalStatus(file.url);
                                  if (approval?.status === 'pending' || approval?.status === 'approved' || approval?.status === 'revision_submitted') {
                                    return; // Non-clickable for these statuses
                                  }
                                  
                                  if (approval?.status === 'needs_changes') {
                                    handleRevisionClick(execution.executionId, file.url, file.filename, approval?.feedback || '', task.taskId, approval?.note);
                                  } else {
                                    handleApprovalClick(execution.executionId, file.url, file.filename);
                                  }
                                }}
                                title={(() => {
                                  const approval = getApprovalStatus(file.url);
                                  if (!approval) return "Send for approval";
                                  
                                  switch (approval.status) {
                                    case 'pending':
                                      return `Review request sent at ${new Date(approval.createdAt).toLocaleString()} to ${approval.slackChannelName || 'Slack channel'}`;
                                    case 'approved':
                                      return `Approved by ${approval.reviewedBy} at ${new Date(approval.updatedAt).toLocaleString()} in ${approval.slackChannelName || 'Slack channel'}`;
                                    case 'needs_changes':
                                      return `Changes requested by ${approval.reviewedBy} at ${new Date(approval.updatedAt).toLocaleString()} in ${approval.slackChannelName || 'Slack channel'}${approval.feedback ? `\nFeedback: ${approval.feedback}` : ''}`;
                                    case 'revision_submitted':
                                      return `Revision submitted at ${new Date(approval.updatedAt).toLocaleString()} in ${approval.slackChannelName || 'Slack channel'}`;
                                    default:
                                      return "Send for approval";
                                  }
                                })()}
                              >
                                {(() => {
                                  const approval = getApprovalStatus(file.url);
                                  if (!approval) {
                                    return <MessageSquare className="h-4 w-4 text-gray-400 hover:text-blue-500" />;
                                  }
                                  
                                  switch (approval.status) {
                                    case 'pending':
                                      return <MessageSquare className="h-4 w-4 text-blue-500" />;
                                    case 'approved':
                                      return <CheckCircle className="h-4 w-4 text-green-500" />;
                                    case 'needs_changes':
                                      return <AlertTriangle className="h-4 w-4 text-orange-500" />;
                                    case 'revision_submitted':
                                      return <Send className="h-4 w-4 text-gray-400" />;
                                    default:
                                      return <MessageSquare className="h-4 w-4 text-gray-400 hover:text-blue-500" />;
                                  }
                                })()}
                                {(() => {
                                  const approval = getApprovalStatus(file.url);
                                  // Red dot only for needs_changes
                                  if (approval?.feedback && approval.status === 'needs_changes') {
                                    return <div className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" title="Has feedback"></div>;
                                  }
                                  return null;
                                })()}
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
            <DialogTitle>Provide Feedback for Agent</DialogTitle>
            <DialogDescription>
              Share your thoughts on how to improve the generated videos. Your feedback will be used to enhance the AI agent's understanding and generate better results.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="feedback">Feedback (Optional)</Label>
              <Textarea
                id="feedback"
                placeholder="e.g., Make the videos more dynamic, use different camera angles, add more visual effects, change the style to be more cinematic..."
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
        <DialogContent>
          <DialogHeader>
                    <DialogTitle>Archive Video</DialogTitle>
        <DialogDescription>
          Are you sure you want to archive this video? Archived videos will no longer be visible and you will need to contact AgentWeb support to restore them.
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

      {/* Upload Video Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Upload Video Directly</DialogTitle>
            <DialogDescription>
              Upload a video file to add it to the latest execution of this task. The video will be stored in S3 and appear alongside other generated videos.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="videoFile">Select Video File</Label>
              <Input
                id="videoFile"
                type="file"
                accept="video/mp4"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                className="cursor-pointer"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Supported formats: MP4 (max 50MB)
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

      {/* Ad Video Task Creation Dialog */}
      <Dialog open={createTaskDialogOpen} onOpenChange={setCreateTaskDialogOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Ad Video Task</DialogTitle>
            <DialogDescription>
              Configure your ad video generation task by selecting the information to include in the prompt.
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
                placeholder="e.g., Product Launch Ad Videos, Social Media Campaign"
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

            {/* Video Prompt */}
            <div className="space-y-3">
              <Label htmlFor="additionalPrompt" className="text-sm font-medium">
                Video Prompt <span className="text-red-500">*</span>
              </Label>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Describe what videos you want to generate. Include specific details about style, composition, or reference video URLs.
              </p>
              <Textarea
                id="additionalPrompt"
                placeholder="e.g., Create dynamic product videos with smooth transitions, or include reference video: https://example.com/reference-video.mp4"
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
              onClick={handleCreateAdVideoTask}
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
                    onClick={() => setVideoPreviewOpen(false)}
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Main content area */}
              <div className="bg-black flex items-center justify-center min-h-[60vh]">
                <video
                  src={previewVideo.url}
                  controls
                  className="max-w-full max-h-[80vh] object-contain"
                  autoPlay
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Channel Selection Dialog */}
      <Dialog open={channelSelectionOpen} onOpenChange={setChannelSelectionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Approval Request</DialogTitle>
            <DialogDescription>
              Choose which Slack channel to send the approval request for: {pendingApprovalVideo?.filename}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="approval-note">Note (Optional)</Label>
              <Textarea
                id="approval-note"
                placeholder="Add a note to provide context for the approval request..."
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
                className="min-h-[80px]"
                disabled={sendingApproval}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                This note will be shown to reviewers in Slack to provide context about the asset.
              </p>
            </div>
            
            <div className="space-y-2">
              <Label>Select Channel</Label>
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
                      <div className="flex items-center space-x-2">
                        <span className="font-medium">{channel.displayName}</span>
                        {channel.isPrivate && (
                          <Badge variant="secondary" className="text-xs">Private</Badge>
                        )}
                      </div>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelApproval}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revision Modal */}
      <Dialog open={revisionModalOpen} onOpenChange={setRevisionModalOpen}>
        <DialogContent className="sm:max-w-[90vw] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Submit Revision</DialogTitle>
            <DialogDescription>
              Please select an existing video from this task to submit as a revision based on the feedback provided.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {revisionVideo && (
              <>
                <div className="space-y-2">
                  <Label>Original Video (Needs Changes)</Label>
                  <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-800">
                    <video 
                      src={revisionVideo.url} 
                      className="max-w-full h-auto max-h-48 object-contain aspect-video"
                      controls
                    />
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                      {revisionVideo.filename}
                    </p>
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label>Feedback</Label>
                  <div className="border rounded-lg p-4 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800">
                    <p className="text-sm text-yellow-800 dark:text-yellow-200">
                      {revisionVideo.feedback || 'No specific feedback provided'}
                    </p>
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="revision-note">Note (Optional)</Label>
                  <Textarea
                    id="revision-note"
                    placeholder="Add or update the note to provide context for the revision..."
                    value={revisionNote}
                    onChange={(e) => setRevisionNote(e.target.value)}
                    className="min-h-[80px]"
                    disabled={submittingRevision}
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    This note will be shown to reviewers in Slack along with the revised asset.
                  </p>
                </div>
                
                <div className="space-y-2">
                  <Label>Select Alternative Video</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-80 overflow-y-auto">
                    {getUnreviewedAlternativeVideos().map((file, fileIndex) => (
                      <div 
                        key={`revision-${fileIndex}`}
                        className={`group relative aspect-video overflow-hidden rounded-lg border cursor-pointer transition-colors ${
                          selectedRevisionVideo === file.url 
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' 
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                        onClick={() => handleRevisionVideoSelect(file.url)}
                      >
                        <video 
                          src={file.url} 
                          className="h-full w-full object-cover"
                          preload="metadata"
                        />
                        {selectedRevisionVideo === file.url && (
                          <div className="absolute top-2 left-2 bg-blue-500 text-white text-xs px-2 py-1 rounded">
                            Selected
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs p-2">
                          <p className="truncate">{file.filename}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Select an unreviewed video from this task to submit as a revision.
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
              disabled={!selectedRevisionVideo || submittingRevision}
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

export default VideosPage;