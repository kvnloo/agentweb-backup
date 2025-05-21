import React from "react";
import { DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Archive, Play } from "lucide-react";
import { toast } from "sonner";

interface TaskActionsProps {
  taskId: string;
  status: "completed" | "failed" | "running" | "queued";
  onRunTask: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
  onClose: () => void;
}

export const TaskActions: React.FC<TaskActionsProps> = ({
  taskId,
  status,
  onRunTask,
  onArchiveTask,
  onClose,
}) => {
  return (
    <DialogFooter className="flex justify-between items-center mt-4">
      <div>
        <Button
          variant="destructive"
          onClick={() => {
            onArchiveTask(taskId);
            onClose();
            toast.success("Task archived");
          }}
        >
          <Archive className="h-4 w-4 mr-2" /> Archive Task
        </Button>
      </div>
      <div className="flex gap-2">
        <Button className="secondary-button" onClick={onClose}>
          Close
        </Button>
        <Button
          onClick={() => {
            onRunTask(taskId);
            onClose();
            toast.success("Task started");
          }}
          disabled={status === "running"}
        >
          <Play className="h-4 w-4 mr-2" /> Run Task
        </Button>
      </div>
    </DialogFooter>
  );
};
