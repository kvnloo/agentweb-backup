import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// Import Components
import { TaskHeader } from "@/components/tasks/TaskHeader";
import { TaskDetailsSection } from "@/components/tasks/TaskDetailsSection";
import { LLMSelector } from "@/components/tasks/LLMSelector";
import { TaskOptionsSelector } from "@/components/tasks/TaskOptionsSelector";
import { TaskScheduler } from "@/components/tasks/TaskScheduler";
import {
  SubscriberManager,
  TaskSubscriber,
} from "@/components/tasks/SubscriberManager";
import {
  ExecutionHistory,
  TaskExecution,
} from "@/components/tasks/ExecutionHistory";
import { TaskActions } from "@/components/tasks/TaskActions";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

// Re-export types properly for isolatedModules mode
export type { TaskSubscriber };
export type { TaskExecution };

// Define a type for the task updates
export interface TaskUpdates {
  title?: string;
  description?: string;
  options?: {
    emailMe?: boolean;
    interactiveMode?: boolean;
    performDeepResearch?: boolean;
    complexTask?: boolean;
    extractPageContent?: boolean;
    validateOutput?: boolean;
    outputAsJSON?: boolean;
  };
  schedule?: {
    frequency?: string;
    enabled?: boolean;
  };
  subscribers?: TaskSubscriber[];
  preferred_llm?: string;
  sendHtmlReportOnly?: boolean; // Whether to send only HTML reports to all subscribers
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  created: string;
  completed?: string;
  options?: {
    emailMe?: boolean;
    interactiveMode?: boolean;
    performDeepResearch?: boolean;
    complexTask?: boolean;
    extractPageContent?: boolean;
    validateOutput?: boolean;
    outputAsJSON?: boolean;
  };
  schedule?: {
    frequency: string;
    enabled: boolean;
  };
  subscribers?: TaskSubscriber[];
  executions?: TaskExecution[];
  preferred_llm?: string;
  sendHtmlReportOnly?: boolean; // Whether to send only HTML reports to all subscribers
}

export interface TaskDetailProps {
  task: {
    id: string;
    title: string;
    description: string;
    status: "completed" | "failed" | "running" | "queued";
    created: string;
    completed?: string;
    executions?: TaskExecution[];
    preferred_llm?: string;
    subscribers?: TaskSubscriber[];
    schedule?: {
      frequency: string;
      enabled: boolean;
    };
    options?: {
      emailMe: boolean;
      interactiveMode: boolean;
      performDeepResearch: boolean;
      complexTask: boolean;
      extractPageContent: boolean;
      validateOutput: boolean;
      outputAsJSON: boolean;
    };
    sendHtmlReportOnly?: boolean; // Whether to send only HTML reports to all subscribers
  };
  isOpen: boolean;
  onClose: () => void;
  onRunTask: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: TaskUpdates) => void;
}

const TaskDetailModal: React.FC<TaskDetailProps> = ({
  task,
  isOpen,
  onClose,
  onRunTask,
  onArchiveTask,
  onUpdateTask,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(task.title);
  const [editedDescription, setEditedDescription] = useState(task.description);

  // Initialize options with defaults or from task
  const [options, setOptions] = useState({
    emailMe: task.options?.emailMe || false,
    interactiveMode: task.options?.interactiveMode || false,
    performDeepResearch: task.options?.performDeepResearch || false,
    complexTask: task.options?.complexTask || false,
    extractPageContent: task.options?.extractPageContent || false,
    validateOutput: task.options?.validateOutput || false,
    outputAsJSON: task.options?.outputAsJSON || false,
  });

  // Initialize schedule with defaults or from task
  const [schedule, setSchedule] = useState({
    frequency: task.schedule?.frequency || "",
    enabled: task.schedule?.enabled || false,
  });

  // Initialize subscribers
  const [subscribers, setSubscribers] = useState<TaskSubscriber[]>(
    task.subscribers || []
  );

  // Initialize preferred LLM
  const [preferredLLM, setPreferredLLM] = useState(
    task.preferred_llm || "gpt-4o"
  );

  // Mock execution data if none provided
  const executions = task.executions || [];
  if (executions.length === 0 && task.status === "completed") {
    executions.push({
      id: `exec-${task.id}`,
      status: "completed",
      startedAt: task.created,
      completedAt: task.completed || task.created,
      prompt: task.description,
      result: "Task completed successfully.",
    });
  }

  const toggleOption = (option: keyof typeof options) => {
    setOptions({
      ...options,
      [option]: !options[option],
    });
  };

  const handleSaveChanges = () => {
    onUpdateTask(task.id, {
      title: editedTitle,
      description: editedDescription,
      options,
      schedule,
      subscribers,
      preferred_llm: preferredLLM,
      sendHtmlReportOnly: task.sendHtmlReportOnly,
    });
    setIsEditing(false);
    toast.success("Task updated successfully");
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <TaskHeader
            title={task.title}
            status={task.status}
            isEditing={isEditing}
            editedTitle={editedTitle}
            onEditToggle={() => setIsEditing(!isEditing)}
            onTitleChange={(e) => setEditedTitle(e.target.value)}
          />
        </DialogHeader>

        <div className="space-y-6">
          <TaskDetailsSection
            description={task.description}
            created={task.created}
            completed={task.completed}
            isEditing={isEditing}
            editedDescription={editedDescription}
            onDescriptionChange={(e) => setEditedDescription(e.target.value)}
          />

          {isEditing && (
            <div className="mt-6 space-y-6">
              {/* Preferred LLM */}
              <LLMSelector
                preferredLLM={preferredLLM}
                onLLMChange={setPreferredLLM}
              />

              {/* Task Options */}
              <TaskOptionsSelector
                options={options}
                onToggleOption={toggleOption}
              />

              {/* Schedule Task */}
              <TaskScheduler taskId={task.id} />

              {/* HTML Report Only Toggle */}
              <div className="space-y-3">
                <h4 className="text-md font-medium">Email Settings</h4>
                <div className="flex items-center space-x-2">
                  <Switch
                    id="html-report-only-modal"
                    checked={!!task.sendHtmlReportOnly}
                    onCheckedChange={(checked) => {
                      const updatedTask = { ...task, sendHtmlReportOnly: checked };
                      onUpdateTask(task.id, {
                        title: updatedTask.title,
                        description: updatedTask.description,
                        options: updatedTask.options,
                        schedule: updatedTask.schedule,
                        subscribers: updatedTask.subscribers,
                        preferred_llm: updatedTask.preferred_llm,
                        sendHtmlReportOnly: updatedTask.sendHtmlReportOnly,
                      });
                    }}
                  />
                  <Label htmlFor="html-report-only-modal" className="text-sm">
                    Send HTML Report Only
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  When enabled, emails to subscribers will only contain the HTML report without task execution context. It is suited for tasks such as news letters, blog posts, and other content-based tasks.
                </p>
              </div>

              {/* Subscribers */}
              <SubscriberManager
                subscribers={subscribers}
                onSubscribersChange={setSubscribers}
              />
            </div>
          )}

          {isEditing && (
            <div className="flex justify-end mt-6">
              <Button
                onClick={handleSaveChanges}
                className="mr-2 use-template-button"
              >
                Save Changes
              </Button>
              <Button
                className="secondary-button"
                onClick={() => setIsEditing(false)}
              >
                Cancel
              </Button>
            </div>
          )}

          <ExecutionHistory executions={executions} />
        </div>

        <TaskActions
          taskId={task.id}
          status={task.status}
          onRunTask={onRunTask}
          onArchiveTask={onArchiveTask}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
};

export default TaskDetailModal;
