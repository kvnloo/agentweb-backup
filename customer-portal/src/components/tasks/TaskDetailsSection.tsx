
import React from "react";
import { Calendar, Clock } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface TaskDetailsSectionProps {
  description: string;
  created: string;
  completed?: string;
  isEditing: boolean;
  editedDescription: string;
  onDescriptionChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

export const TaskDetailsSection: React.FC<TaskDetailsSectionProps> = ({
  description,
  created,
  completed,
  isEditing,
  editedDescription,
  onDescriptionChange
}) => {
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  return (
    <div className="space-y-2">
      <h3 className="text-lg font-medium">Task Details</h3>
      
      {!isEditing ? (
        <p className="text-muted-foreground">{description}</p>
      ) : (
        <div className="space-y-4">
          <div>
            <Label htmlFor="description" className="block mb-2">Description</Label>
            <Textarea
              id="description"
              value={editedDescription}
              onChange={onDescriptionChange}
              className="w-full h-24 bg-background text-foreground"
              placeholder="Enter task description"
            />
          </div>
        </div>
      )}
      
      <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2">
        <div className="flex items-center">
          <Calendar className="h-4 w-4 mr-1" />
          <span>Created: {formatDate(created)}</span>
        </div>
        {completed && (
          <div className="flex items-center">
            <Clock className="h-4 w-4 mr-1" />
            <span>Completed: {formatDate(completed)}</span>
          </div>
        )}
      </div>
    </div>
  );
};
