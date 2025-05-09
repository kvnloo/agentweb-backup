
import React from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

interface TaskSchedule {
  frequency: string;
  enabled: boolean;
}

interface TaskSchedulerProps {
  schedule: TaskSchedule;
  onScheduleChange: (schedule: TaskSchedule) => void;
}

export const TaskScheduler: React.FC<TaskSchedulerProps> = ({
  schedule,
  onScheduleChange
}) => {
  const handleCreateSchedule = () => {
    if (!schedule.frequency) {
      toast.error("Please select a frequency");
      return;
    }
    
    onScheduleChange({
      ...schedule,
      enabled: true
    });
    
    toast.success("Schedule created");
  };

  return (
    <div>
      <h4 className="text-md font-medium mb-3">Schedule Task</h4>
      <div className="space-y-4">
        <div>
          <Select
            value={schedule.frequency}
            onValueChange={(value) => onScheduleChange({ ...schedule, frequency: value })}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Frequency" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hourly">Hourly</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={handleCreateSchedule}>Create Schedule</Button>
        {schedule.enabled && (
          <div className="flex justify-between items-center p-3 bg-muted rounded-md">
            <div>Task scheduled to run {schedule.frequency}</div>
            <Switch 
              checked={schedule.enabled}
              onCheckedChange={(checked) => onScheduleChange({ ...schedule, enabled: checked })}
            />
          </div>
        )}
        {!schedule.enabled && (
          <p className="text-sm text-muted-foreground">No schedules found</p>
        )}
      </div>
    </div>
  );
};
