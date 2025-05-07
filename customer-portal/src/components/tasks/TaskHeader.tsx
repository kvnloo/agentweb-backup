
import React from "react";
import { DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, AlertCircle, RotateCcw, Clock, Pencil } from "lucide-react";

interface TaskHeaderProps {
  title: string;
  status: "completed" | "failed" | "running" | "queued";
  isEditing: boolean;
  editedTitle: string;
  onEditToggle: () => void;
  onTitleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const TaskHeader: React.FC<TaskHeaderProps> = ({
  title,
  status,
  isEditing,
  editedTitle,
  onEditToggle,
  onTitleChange
}) => {
  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" /> Completed</Badge>;
      case "running":
        return <Badge className="bg-blue-500"><RotateCcw className="h-3 w-3 mr-1 animate-spin" /> Running</Badge>;
      case "failed":
        return <Badge className="bg-red-500"><AlertCircle className="h-3 w-3 mr-1" /> Failed</Badge>;
      case "queued":
        return <Badge className="bg-gray-500"><Clock className="h-3 w-3 mr-1" /> Queued</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <div className="flex justify-between items-center">
      {!isEditing ? (
        <DialogTitle className="text-xl">{title} {getStatusBadge(status)}</DialogTitle>
      ) : (
        <Input
          type="text"
          value={editedTitle}
          onChange={onTitleChange}
          className="text-xl font-semibold w-full p-2 bg-background text-foreground border-gray-300"
        />
      )}
      <Button variant="ghost" size="icon" onClick={onEditToggle}>
        <Pencil className="h-4 w-4" />
      </Button>
    </div>
  );
};
