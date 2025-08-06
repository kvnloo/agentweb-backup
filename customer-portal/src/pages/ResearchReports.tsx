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
import { Loader2, Search, Filter, Calendar, FileText, ExternalLink, Clock, ArrowUpRight, Play, Zap, Download, Heart, Plus, Archive, Upload, ChevronDown, X, CheckCircle, MessageSquare, AlertTriangle, RefreshCw, Send, Users } from 'lucide-react';
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

interface TaskExecution {
  executionId: string;
  startTime: string | null;
  result_files: ResultFile[];
}

interface TaskWithExecutions {
  taskId: string;
  taskName: string;
  createdAt: string;
  executions: TaskExecution[];
  latestExecutionTime: string | null;
  latestPendingOrRunningExecution: {
    executionId: string;
    status: string;
    startTime: string | null;
  } | null;
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

const ResearchReportsPage: React.FC = () => {
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
  const [pendingArchiveReport, setPendingArchiveReport] = useState<{ executionId: string; reportUrl: string } | null>(null);
  const [reportPreviewOpen, setReportPreviewOpen] = useState(false);
  const [previewReport, setPreviewReport] = useState<{ url: string; filename: string; taskId: string; executionId: string } | null>(null);
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [isSubmittingRevision, setIsSubmittingRevision] = useState(false);
  
  // Approval-related state
  const [channelSelectionOpen, setChannelSelectionOpen] = useState(false);
  const [pendingApprovalReport, setPendingApprovalReport] = useState<{ executionId: string; reportUrl: string; filename: string } | null>(null);
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string; displayName: string }>>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [sendingApproval, setSendingApproval] = useState(false);
  const [approvalNote, setApprovalNote] = useState('');
  const [approvalData, setApprovalData] = useState<{ assets?: Record<string, any> }>({});
  const [revisionModalOpen, setRevisionModalOpen] = useState(false);
  const [revisionReport, setRevisionReport] = useState<{ executionId: string; assetUrl: string; filename: string; feedback: string; taskId: string; note?: string } | null>(null);
  const [selectedRevisionReport, setSelectedRevisionReport] = useState<string | null>(null);
  const [submittingRevision, setSubmittingRevision] = useState(false);
  const [revisionNote, setRevisionNote] = useState('');
  
  // Upload functionality
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadingReport, setUploadingReport] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Create Research Reports functionality
  const [createTaskDialogOpen, setCreateTaskDialogOpen] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [taskName, setTaskName] = useState('');
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [brandData, setBrandData] = useState<BrandData | null>(null);
  const [brandAssets, setBrandAssets] = useState<BrandAsset[]>([]);
  const [marketStrategyData, setMarketStrategyData] = useState<MarketStrategyData | null>(null);
  const [selectedOptions, setSelectedOptions] = useState({
    brandGuidelines: true,
    businessOverview: true,
    icp: [] as string[]
  });

  // Handle escape key to close report preview
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && reportPreviewOpen) {
        setReportPreviewOpen(false);
        setRevisionPrompt('');
      }
    };

    if (reportPreviewOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [reportPreviewOpen]);

  // Reset revision prompt when modal closes
  useEffect(() => {
    if (!reportPreviewOpen) {
      setRevisionPrompt('');
    }
  }, [reportPreviewOpen]);

  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [refreshingExecutions, setRefreshingExecutions] = useState<Set<string>>(new Set());

  const fetchExecutionsWithHtmlReports = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await axios.get<Record<string, TaskWithExecutions>>(
        buildApiUrl('/api/tasks/executions/with-html-reports'),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      setTasksWithExecutions(response.data);
    } catch (err: any) {
      console.error('Error fetching executions with HTML reports:', err);
      setError(err.response?.data?.message || 'Failed to load HTML reports');
    } finally {
      setLoading(false);
    }
  };

  // Efficient refresh function that only updates specific execution results
  // instead of refreshing the entire page data
  const refreshExecutionResults = async (taskId: string, executionId: string) => {
    try {
      setRefreshingExecutions(prev => new Set(prev).add(executionId));
      
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      const updatedExecution = response.data;
      
      // Update the specific execution in our state
      setTasksWithExecutions(prev => {
        const updated = { ...prev };
        if (updated[taskId]) {
          const task = { ...updated[taskId] };
          const executionIndex = task.executions.findIndex((e: TaskExecution) => e.executionId === executionId);
          if (executionIndex !== -1) {
            task.executions[executionIndex] = {
              ...task.executions[executionIndex],
              result_files: updatedExecution.result_files?.filter((file: ResultFile) => {
                const filename = file.filename.toLowerCase();
                return filename.endsWith('.html') || 
                       filename.endsWith('.htm') ||
                       (file.is_html === true);
              }) || []
            };
            updated[taskId] = task;
          }
        }
        return updated;
      });
      
      return updatedExecution;
    } catch (err: any) {
      console.error('Error refreshing execution results:', err);
      return null;
    } finally {
      setRefreshingExecutions(prev => {
        const newSet = new Set(prev);
        newSet.delete(executionId);
        return newSet;
      });
    }
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
            fetchExecutionsWithHtmlReports();
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
    fetchExecutionsWithHtmlReports();
  }, []);

  // Load approval data when tasks change
  useEffect(() => {
    if (Object.keys(tasksWithExecutions).length > 0 && token) {
      loadApprovalData();
    }
  }, [tasksWithExecutions, token]);

  // Start/stop auto-refresh based on active executions
  useEffect(() => {
    const hasActiveExecutions = Object.values(tasksWithExecutions).some(
      task => task.latestPendingOrRunningExecution !== null
    );

    if (hasActiveExecutions) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }

    return () => stopAutoRefresh();
  }, [tasksWithExecutions]);



  const handleViewReport = (url: string, filename: string, taskId: string, executionId: string) => {
    setPreviewReport({ url, filename, taskId, executionId });
    setReportPreviewOpen(true);
  };

  const handleDownloadReport = (url: string, filename: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleFavoriteReport = async (executionId: string, reportUrl: string) => {
    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/executions/${executionId}/favorite-image`),
        { imageUrl: reportUrl },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        // Update the specific report's favorite status in local state
        setTasksWithExecutions(prev => {
          const updated = { ...prev };
          Object.keys(updated).forEach(taskId => {
            const task = updated[taskId];
            task.executions = task.executions.map(execution => {
              if (execution.executionId === executionId) {
                return {
                  ...execution,
                  result_files: execution.result_files.map(file => {
                    if (file.url === reportUrl) {
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
            ? "Report has been added to your favorites." 
            : "Report has been removed from your favorites.",
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

  const handleArchiveReport = async (executionId: string, reportUrl: string) => {
    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/executions/${executionId}/archive-image`),
        { imageUrl: reportUrl },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        // Update the specific report's archived status in local state
        setTasksWithExecutions(prev => {
          const updated = { ...prev };
          Object.keys(updated).forEach(taskId => {
            const task = updated[taskId];
            task.executions = task.executions.map(execution => {
              if (execution.executionId === executionId) {
                return {
                  ...execution,
                  result_files: execution.result_files.map(file => {
                    if (file.url === reportUrl) {
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
          title: "Report Archived",
          description: "Report has been archived and will no longer be visible. Contact AgentWeb support to restore it.",
        });
      }
    } catch (error: any) {
      console.error('Error archiving report:', error);
      toast({
        title: "Error",
        description: error.response?.data?.message || "Failed to archive report.",
        variant: "destructive",
      });
    }
  };

  const handleApprovalClick = async (executionId: string, assetUrl: string, filename: string) => {
    setPendingApprovalReport({ executionId, reportUrl: assetUrl, filename });
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
    if (!pendingApprovalReport || !token) return;

    setSendingApproval(true);
    try {
      const assetType = 'html'; // HTML reports are always html type
      
      // Find the channel name from the selected channel ID
      const selectedChannel = slackChannels.find(ch => ch.id === channelId);
      const channelName = selectedChannel?.name || channelId;
      
      const response = await axios.post(
        buildApiUrl('/api/slack/send-approval'),
        {
          channel: channelId,
          channelName: channelName,
          assetUrl: pendingApprovalReport.reportUrl,
          filename: pendingApprovalReport.filename,
          assetType,
          executionId: pendingApprovalReport.executionId,
          note: approvalNote.trim() || undefined, // Include note if provided
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
        setPendingApprovalReport(null);
        setApprovalNote(''); // Reset note after successful send
        
        // Refresh approval data immediately and then again after a delay
        await loadApprovalData();
        setTimeout(async () => {
          await loadApprovalData();
        }, 2000);
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
    setPendingApprovalReport(null);
    setApprovalNote(''); // Reset note when canceling
  };

  const handleRevisionClick = (executionId: string, assetUrl: string, filename: string, feedback: string, taskId: string, note?: string) => {
    setRevisionReport({ executionId, assetUrl, filename, feedback, taskId, note });
    setSelectedRevisionReport(null);
    setRevisionNote(note || ''); // Copy the original note
    setRevisionModalOpen(true);
  };

  const handleSubmitApprovalRevision = async () => {
    if (!revisionReport || !selectedRevisionReport || !token) return;

    setSubmittingRevision(true);
    try {
      const response = await axios.post(
        buildApiUrl('/api/slack/submit-revision'),
        {
          executionId: revisionReport.executionId,
          originalAssetUrl: revisionReport.assetUrl,
          originalFilename: revisionReport.filename,
          selectedAssetUrl: selectedRevisionReport,
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
        setRevisionReport(null);
        setSelectedRevisionReport(null);
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
    setRevisionReport(null);
    setSelectedRevisionReport(null);
    setRevisionNote(''); // Reset note when canceling
  };

  const handleSubmitRevision = async () => {
    if (!previewReport || !revisionPrompt.trim()) {
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
        buildApiUrl(`/api/tasks/${previewReport.taskId}/executions/revision`),
        {
          revision_prompt: revisionPrompt.trim(),
          report_url: previewReport.url,
          original_execution_id: previewReport.executionId
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (response.data.success) {
        toast({
          title: "Revision Submitted",
          description: "Your report revision request has been submitted. The new execution will start shortly.",
        });
        setReportPreviewOpen(false);
        setRevisionPrompt('');
        // Refresh the executions to show the new pending execution
        await fetchExecutionsWithHtmlReports();
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
    } catch (error: any) {
      console.error('Error loading approval data:', error);
    }
  };

  const getApprovalStatus = (assetUrl: string) => {
    return approvalData.assets?.[assetUrl] || null;
  };

  const formatDate = (dateString: string | undefined) => {
    if (!dateString) return 'Unknown';
    try {
      return format(new Date(dateString), 'MMM d, yyyy HH:mm');
    } catch {
      return 'Invalid date';
    }
  };

  const handleArchiveConfirm = async () => {
    if (pendingArchiveReport) {
      await handleArchiveReport(pendingArchiveReport.executionId, pendingArchiveReport.reportUrl);
      setArchiveDialogOpen(false);
      setPendingArchiveReport(null);
    }
  };

  const handleArchiveCancel = () => {
    setArchiveDialogOpen(false);
    setPendingArchiveReport(null);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'failed':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      case 'running':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200';
    }
  };

  // Generate More functionality
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
        description: "Task execution started with your feedback. New reports will appear shortly." 
      });
      
      // Refresh the data after a short delay to show the new execution
      setTimeout(() => {
        fetchExecutionsWithHtmlReports();
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

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Check if file is an HTML file
      if (!file.name.toLowerCase().endsWith('.html') && !file.name.toLowerCase().endsWith('.htm')) {
        toast({
          title: "Error",
          description: "Please select an HTML file.",
          variant: "destructive",
        });
        return;
      }
      setSelectedFile(file);
    }
  };

  const handleUploadReport = async () => {
    if (!pendingTaskId || !selectedFile || !token) {
      toast({
        title: "Error",
        description: "Please select a file to upload.",
        variant: "destructive",
      });
      return;
    }

    setUploadingReport(true);
    
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
        description: "Report uploaded successfully and added to the latest execution." 
      });
      
      setUploadDialogOpen(false);
      setSelectedFile(null);
      setPendingTaskId(null);
      
      // Refresh the data to show the new report
      setTimeout(() => {
        // Try to refresh just the latest execution first
        const task = tasksWithExecutions[pendingTaskId];
        if (task && task.latestPendingOrRunningExecution) {
          refreshExecutionResults(pendingTaskId, task.latestPendingOrRunningExecution.executionId);
        } else {
          // Fallback to full refresh if no active execution
          fetchExecutionsWithHtmlReports();
        }
      }, 1000);
      
    } catch (err: any) {
      console.error('Failed to upload report:', err);
      toast({
        title: "Error Uploading Report",
        description: err.response?.data?.message || "Could not upload report.",
        variant: "destructive",
      });
    } finally {
      setUploadingReport(false);
    }
  };

  const handleUploadCancel = () => {
    setUploadDialogOpen(false);
    setSelectedFile(null);
    setPendingTaskId(null);
  };

  // Helper functions for dropdown functionality
  const hasActiveExecutions = () => {
    return Object.values(tasksWithExecutions).some(task => task.latestPendingOrRunningExecution !== null);
  };

  const isCurrentlyExecuting = (taskId: string) => {
    return executingTasks.has(taskId);
  };

  const canGenerateMore = (taskId: string) => {
    const task = tasksWithExecutions[taskId];
    const hasActiveExecution = task?.latestPendingOrRunningExecution !== null;
    const isExecuting = executingTasks.has(taskId);
    return !hasActiveExecution && !isExecuting;
  };

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

  const handleCreateResearchReportTask = async () => {
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
        description: "Research Prompt is required. Please describe what research reports you want to generate.",
        variant: "destructive",
      });
      return;
    }

    setIsCreatingTask(true);
    
    try {
      // Build the prompt based on selected options
      let prompt = "Please create a comprehensive HTML research report that aligns with the below context and target the specified audience. The report should be professional, well-structured, and suitable for business analysis. Use write_file to create the HTML report with proper formatting.\n\n";
      
      // Add task description
      if (additionalPrompt.trim()) {
        prompt += `Research Prompt:\n${additionalPrompt.trim()}\n\n`;
      }
      
      if (selectedOptions.brandGuidelines && brandData) {
        prompt += `Brand Guidelines:\nIMPORTANT: Use the following brand data including logo, typography, brand colors, and other brand elements to maintain consistency in generated reports. Ensure all reports align with the brand identity.\n\n`;
        
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
            category: 'Research',
            description: `Research report generation targeting ${icp.title} audience`,
            outputAsHtml: true
          });
        }
      } else {
        // Create a single task for general audience
        tasksToCreate.push({
          name: taskName.trim(),
          prompt: prompt,
          category: 'Research',
          description: 'Research report generation for general audience',
          outputAsHtml: true
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
        description: `Created ${createdTasks.length} research report generation task${createdTasks.length > 1 ? 's' : ''}. You will be redirected to the Tasks page.`,
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
      console.error('Failed to create research report tasks:', err);
      toast({
        title: "Error Creating Tasks",
        description: err.response?.data?.message || "Could not create research report tasks.",
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

  const totalReports = allTasks.reduce(
    (total, task) => total + task.executions.reduce((taskTotal, execution) => 
      taskTotal + execution.result_files.filter(file => !file.is_archived).length, 0),
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
          <span>Loading HTML reports...</span>
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Research Reports</h1>
          <p className="text-gray-600 dark:text-gray-400">
            All HTML research reports generated by your tasks ({totalReports} reports from {totalExecutions} executions across {allTasks.length} tasks)
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
            Create Research Reports
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <Input
              placeholder="Search tasks..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latestExecution">Latest Execution</SelectItem>
              <SelectItem value="name">Task Name</SelectItem>
              <SelectItem value="taskId">Task ID</SelectItem>
              <SelectItem value="createdAt">Created Date</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Tasks Grid */}
      <div className="space-y-4">
        {allTasks.length === 0 ? (
          <div className="text-center py-12">
            <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              No HTML reports found
            </h3>
            <p className="text-gray-500 dark:text-gray-400">
              {searchTerm ? 'Try adjusting your search terms.' : 'Create some tasks that generate HTML reports to see them here.'}
            </p>
          </div>
        ) : (
          allTasks.map((task) => {
            const hasActiveExecution = task.latestPendingOrRunningExecution !== null;
            
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
                            Generating reports... Started: {formatDate(task.latestPendingOrRunningExecution!.startTime)}
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
                            disabled={!canGenerateMore(task.taskId)}
                            size="sm"
                            className="whitespace-nowrap"
                          >
                            {isCurrentlyExecuting(task.taskId) ? (
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
                            className="aspect-[4/3] overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer bg-gray-50 dark:bg-gray-800"
                            onClick={() => handleViewReport(file.url, file.filename, task.taskId, execution.executionId)}
                            title="Click to preview report"
                          >
                            <div className="h-full w-full flex flex-col items-center justify-center p-4">
                              <FileText className="h-12 w-12 text-gray-400 mb-2" />
                              <div className="text-center">
                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                  Click to preview
                                </div>
                              </div>
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
                                title="Download Report"
                              >
                                <Download className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-800"
                                onClick={() => handleFavoriteReport(execution.executionId, file.url)}
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
                                  const channel = approval?.slackChannelName || approval?.slackChannel || 'Unknown channel';
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
                                        status === 'pending' || status === 'approved' || status === 'revision_submitted'
                                          ? undefined 
                                          : status === 'needs_changes'
                                            ? () => handleRevisionClick(execution.executionId, file.url, file.filename, approval?.feedback || '', task.taskId, approval?.note)
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
                                        <Send className="h-4 w-4 text-gray-400" />
                                      ) : (
                                        <MessageSquare className="h-4 w-4 text-gray-400 hover:text-blue-500" />
                                      )}
                                      {approval?.feedback && status === 'needs_changes' && (
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
                                onClick={() => {
                                  setPendingArchiveReport({ executionId: execution.executionId, reportUrl: file.url });
                                  setArchiveDialogOpen(true);
                                }}
                                title="Archive Report"
                              >
                                <Archive className="h-4 w-4 text-gray-400 hover:text-red-500" />
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
          })
        )}
      </div>

      {/* Archive Confirmation Dialog */}
      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Archive Report</DialogTitle>
            <DialogDescription>
              Are you sure you want to archive this report? Archived reports will no longer be visible and you will need to contact AgentWeb support to restore them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleArchiveCancel}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleArchiveConfirm}>
              Archive Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Report Preview Dialog */}
      <Dialog open={reportPreviewOpen} onOpenChange={setReportPreviewOpen}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 overflow-auto">
          {previewReport && (
            <div className="bg-white">
              {/* Header */}
              <div className="sticky top-0 bg-gray-900 border-b border-gray-600 p-4 pr-4 flex items-center justify-between z-10">
                <div className="text-white text-sm font-medium">
                  {previewReport.filename}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
                    onClick={() => handleDownloadReport(previewReport.url, previewReport.filename)}
                    title="Download Report"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 bg-gray-800 text-white hover:bg-gray-700"
                    onClick={() => {
                      setReportPreviewOpen(false);
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
                {/* Report - Left side */}
                <div className="flex-1 bg-white p-4">
                  <iframe
                    src={previewReport.url}
                    className="w-full h-[80vh] border border-gray-200 rounded-lg"
                    title={previewReport.filename}
                  />
                </div>

                {/* Revision Prompt Section - Right side */}
                <div className="w-80 bg-gray-900 border-l border-gray-600 p-4 flex flex-col">
                  <div className="flex-1">
                    <Label htmlFor="revisionPrompt" className="text-white text-sm font-medium mb-3 block">
                      Report Revision Prompt
                    </Label>
                    <Textarea
                      id="revisionPrompt"
                      placeholder="Describe how you'd like to revise this report (e.g., 'Add more market analysis', 'Include competitor data', 'Make it more detailed')"
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Approval Request</DialogTitle>
            <DialogDescription>
              Select a Slack channel to send the approval request for this report.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="approvalNote" className="text-sm font-medium">
                Note (Optional)
              </Label>
              <Textarea
                id="approvalNote"
                placeholder="Add any additional context or instructions for reviewers..."
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
                rows={3}
              />
            </div>
            
            <div className="space-y-2">
              <Label className="text-sm font-medium">Select Channel</Label>
              {loadingChannels ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="ml-2">Loading channels...</span>
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto space-y-2">
                  {slackChannels.map((channel) => (
                    <Button
                      key={channel.id}
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => handleSendApprovalRequest(channel.id)}
                      disabled={sendingApproval}
                    >
                      <MessageSquare className="h-4 w-4 mr-2" />
                      {channel.displayName || channel.name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelApproval} disabled={sendingApproval}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revision Modal */}
      <Dialog open={revisionModalOpen} onOpenChange={setRevisionModalOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Submit Revision</DialogTitle>
            <DialogDescription>
              Select an alternative report to submit as a revision for the feedback received.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Original Feedback</Label>
              <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {revisionReport?.feedback || 'No feedback provided'}
                </p>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label className="text-sm font-medium">Revision Note (Optional)</Label>
              <Textarea
                placeholder="Add a note explaining your revision..."
                value={revisionNote}
                onChange={(e) => setRevisionNote(e.target.value)}
                rows={3}
              />
            </div>
            
            <div className="space-y-2">
              <Label className="text-sm font-medium">Select Alternative Report</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-80 overflow-y-auto">
                {revisionReport?.taskId && tasksWithExecutions[revisionReport.taskId]?.executions.flatMap((execution, executionIndex) => 
                  execution.result_files
                    .filter(file => {
                      if (file.is_archived || file.url === revisionReport.assetUrl) return false;
                      const approval = getApprovalStatus(file.url);
                      return !approval || (approval.status !== 'pending' && approval.status !== 'approved' && approval.status !== 'needs_changes' && approval.status !== 'revision_submitted');
                    })
                    .map((file, fileIndex) => (
                      <div 
                        key={`${execution.executionId}-${fileIndex}`}
                        className={`group relative aspect-[4/3] overflow-hidden rounded-lg border cursor-pointer transition-colors ${
                          selectedRevisionReport === file.url 
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' 
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                        onClick={() => setSelectedRevisionReport(file.url)}
                      >
                        <div className="h-full w-full flex flex-col items-center justify-center p-4">
                          <FileText className="h-8 w-8 text-gray-400 mb-2" />
                          <div className="text-center">
                            <div className="text-xs font-medium text-gray-900 dark:text-white truncate">
                              {file.filename}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              HTML Report
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelRevision} disabled={submittingRevision}>
              Cancel
            </Button>
            <Button 
              onClick={handleSubmitApprovalRevision}
              disabled={!selectedRevisionReport || submittingRevision}
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

      {/* Feedback Dialog */}
      <Dialog open={feedbackDialogOpen} onOpenChange={setFeedbackDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Provide Feedback for Agent</DialogTitle>
            <DialogDescription>
              Share your thoughts on how to improve the generated reports. Your feedback will be used to enhance the AI agent's understanding and generate better results.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="feedback">Feedback (Optional)</Label>
              <Textarea
                id="feedback"
                placeholder="e.g., Make the reports more detailed, use different research sources, add more visualizations, change the style to be more comprehensive..."
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
              Generate Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Upload HTML Report</DialogTitle>
            <DialogDescription>
              Upload an HTML report file to add it to the latest execution of this task.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="file">Select HTML File</Label>
              <Input
                id="file"
                type="file"
                accept=".html,.htm"
                onChange={handleFileSelect}
                className="cursor-pointer"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Only HTML files (.html, .htm) are supported.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleUploadCancel}>
              Cancel
            </Button>
            <Button 
              onClick={handleUploadReport}
              disabled={!selectedFile || uploadingReport}
            >
              {uploadingReport ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                'Upload Report'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Research Reports Dialog */}
      <Dialog open={createTaskDialogOpen} onOpenChange={setCreateTaskDialogOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Research Report Task</DialogTitle>
            <DialogDescription>
              Configure your research report generation task by selecting the information to include in the prompt.
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
                placeholder="e.g., Market Research Report, Competitive Analysis, Industry Trends Report"
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

            {/* Research Prompt */}
            <div className="space-y-3">
              <Label htmlFor="additionalPrompt" className="text-sm font-medium">
                Research Prompt <span className="text-red-500">*</span>
              </Label>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Describe what research reports you want to generate. Include specific details about research type, data sources, analysis depth, or report structure.
              </p>
              <Textarea
                id="additionalPrompt"
                placeholder="e.g., Create comprehensive market analysis reports with industry trends, competitive landscape, and growth opportunities"
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
              onClick={handleCreateResearchReportTask}
              disabled={!taskName.trim() || !additionalPrompt.trim() || isCreatingTask}
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

export default ResearchReportsPage; 