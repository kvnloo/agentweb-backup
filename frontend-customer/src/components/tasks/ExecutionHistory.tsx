
import React, { useState } from "react";
import { X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, AlertCircle } from "lucide-react";

export interface TaskExecution {
  id: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  prompt?: string;
  result?: string;
  details?: string;
}

interface ExecutionHistoryProps {
  executions: TaskExecution[];
}

export const ExecutionHistory: React.FC<ExecutionHistoryProps> = ({
  executions
}) => {
  const [selectedExecution, setSelectedExecution] = useState<TaskExecution | null>(null);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" /> Completed</Badge>;
      case "failed":
        return <Badge className="bg-red-500"><AlertCircle className="h-3 w-3 mr-1" /> Failed</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Execution History</CardTitle>
      </CardHeader>
      <CardContent>
        {executions.length > 0 ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.map((execution) => (
                  <TableRow 
                    key={execution.id} 
                    className="cursor-pointer hover:bg-muted"
                    onClick={() => setSelectedExecution(execution)}
                  >
                    <TableCell>{getStatusBadge(execution.status)}</TableCell>
                    <TableCell>{formatDate(execution.startedAt)}</TableCell>
                    <TableCell>{formatDate(execution.completedAt)}</TableCell>
                    <TableCell>
                      <div className="max-w-xs truncate">
                        {execution.result || "No result data"}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {selectedExecution && (
              <div className="mt-6 space-y-4 border-t pt-4">
                <div className="flex justify-between items-center">
                  <h4 className="font-medium">Execution Details</h4>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={() => setSelectedExecution(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <Label className="block mb-1">Prompt</Label>
                    <div className="bg-muted p-3 rounded-md text-sm">
                      {selectedExecution.prompt || "No prompt data available"}
                    </div>
                  </div>
                  
                  <div>
                    <Label className="block mb-1">Result</Label>
                    <div className="bg-muted p-3 rounded-md text-sm whitespace-pre-wrap">
                      {selectedExecution.result || "No result data available"}
                    </div>
                  </div>
                  
                  {selectedExecution.details && (
                    <div>
                      <Label className="block mb-1">Additional Details</Label>
                      <div className="bg-muted p-3 rounded-md text-sm whitespace-pre-wrap">
                        {selectedExecution.details}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-center text-muted-foreground py-4">No execution history available</p>
        )}
      </CardContent>
    </Card>
  );
};
