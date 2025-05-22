import React, { useEffect, useState } from "react";
import axios, { AxiosError } from "axios";
import { useAuth } from "@/contexts/AuthContext";
import { buildApiUrl } from "@/config";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Loader2, Trash2 } from "lucide-react";

interface Schedule {
  scheduleId: string;
  taskId: string;
  frequency: string;
  status: string;
  nextRunTime: string;
  createdAt: string;
}

interface TaskSchedulerProps {
  taskId: string;
}

export const TaskScheduler: React.FC<TaskSchedulerProps> = ({ taskId }) => {
  const { token } = useAuth();
  const [frequency, setFrequency] = useState("");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchSchedules = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await axios.get(
        buildApiUrl(`/api/schedules/task/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      setSchedules(response.data);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.error || "Failed to load schedules");
      } else {
        setError("Failed to load schedules");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token && taskId) fetchSchedules();
    // eslint-disable-next-line
  }, [taskId, token]);

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setIsSubmitting(true);
    try {
      await axios.post(
        buildApiUrl("/api/schedules"),
        { taskId, frequency },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      setSuccess("Schedule created successfully");
      setFrequency("");
      fetchSchedules();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.error || "Failed to create schedule");
      } else {
        setError("Failed to create schedule");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleStatus = async (
    scheduleId: string,
    currentStatus: string
  ) => {
    try {
      await axios.put(
        buildApiUrl(`/api/schedules/${scheduleId}`),
        {
          status: currentStatus === "active" ? "paused" : "active",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchSchedules();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(
          err.response?.data?.error || "Failed to update schedule status"
        );
      } else {
        setError("Failed to update schedule status");
      }
    }
  };

  const handleDelete = async (scheduleId: string) => {
    try {
      await axios.delete(buildApiUrl(`/api/schedules/${scheduleId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchSchedules();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.error || "Failed to delete schedule");
      } else {
        setError("Failed to delete schedule");
      }
    }
  };

  return (
    <div className="mt-8">
      <h4 className="text-md font-medium mb-3">Task Scheduling</h4>
      <form
        onSubmit={handleCreateSchedule}
        className="flex gap-4 items-end mb-4"
      >
        <div className="w-48">
          <Select value={frequency} onValueChange={setFrequency}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Frequency" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          type="submit"
          disabled={isSubmitting || !frequency}
          className="use-template-button"
        >
          {isSubmitting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Create Schedule
        </Button>
      </form>
      {error && (
        <Alert variant="destructive" className="mb-2">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <Alert className="mb-2">
          <AlertTitle>Success</AlertTitle>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <div className="flex items-center py-8 justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="ml-2 text-muted-foreground">
            Loading schedules...
          </span>
        </div>
      ) : schedules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No schedules found</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Frequency</TableHead>
              <TableHead>Next Run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((schedule) => (
              <TableRow key={schedule.scheduleId}>
                <TableCell>{schedule.frequency}</TableCell>
                <TableCell>
                  {new Date(schedule.nextRunTime).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={schedule.status === "active"}
                    onCheckedChange={() =>
                      handleToggleStatus(schedule.scheduleId, schedule.status)
                    }
                  />
                </TableCell>
                <TableCell>
                  {new Date(schedule.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Button
                    size="icon"
                    className="secondary-button"
                    onClick={() => handleDelete(schedule.scheduleId)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
};
