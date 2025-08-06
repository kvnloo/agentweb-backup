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
import { Loader2, Search, Filter, Calendar, FileText, ExternalLink, Clock, ArrowUpRight, Play, Zap, Download, Heart, Plus, Archive, Upload, ChevronDown, X, CheckCircle, MessageSquare, AlertTriangle, RefreshCw, Send } from 'lucide-react';
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
  brandGuidelines: string;
  businessOverview: string;
  icp: Array<{ id: string; name: string; description: string }>;
}

interface BrandAsset {
  id: string;
  name: string;
  description: string;
  type: string;
}

interface MarketStrategyData {
  marketStrategy: string;
  competitiveAnalysis: string;
  targetAudience: string;
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
                                <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                                  {file.filename}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                  HTML Report
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

              {/* Main content area */}
              <div className="bg-white p-4">
                <iframe
                  src={previewReport.url}
                  className="w-full h-[80vh] border border-gray-200 rounded-lg"
                  title={previewReport.filename}
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
    </div>
  );
};

export default ResearchReportsPage; 