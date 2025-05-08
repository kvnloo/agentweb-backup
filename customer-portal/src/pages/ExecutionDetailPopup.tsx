import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Define Execution Status type - keep consistent with other files
type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'queued';

// Define Execution interface - Fields expected from sessionStorage
interface Execution {
  executionId: string;
  status: ExecutionStatus;
  startTime: string;
  completedAt?: string;
  taskId: string;
  llmName?: string;
  prompt: string;
  result: string;
}

const formatDate = (dateStr?: string) => {
  if (!dateStr) return 'N/A';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      const parts = dateStr.match(/(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):?(\d{2}))?/);
      if (parts) {
        const isoStr = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}${parts[7] || 'Z'}`;
        const parsedDate = new Date(isoStr);
        if (!isNaN(parsedDate.getTime())) return parsedDate.toLocaleString();
      }
      return 'Invalid Date';
    }
    return date.toLocaleString();
  } catch (e) {
    return 'Invalid Date';
  }
};

const SESSION_STORAGE_KEY = 'currentExecutionPopupData';

const ExecutionDetailPopupPage: React.FC = () => {
  const [execution, setExecution] = useState<Execution | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const storedData = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (storedData) {
      try {
        const parsedData = JSON.parse(storedData) as Execution;
        setExecution(parsedData);
      } catch (e) {
        console.error("Failed to parse execution data from sessionStorage:", e);
        setError("Failed to load execution details. Data might be corrupted.");
      }
    } else {
      setError("Execution details not found. Please try opening it again from the task page.");
    }

    // Close popup when it loses focus
    const handleBlur = () => {
      window.close();
    };
    window.addEventListener('blur', handleBlur);

    // Cleanup
    return () => {
      window.removeEventListener('blur', handleBlur);
      // Optional: Clear the item when the popup is closed or navigates away
      // This helps prevent showing stale data if the user reopens a popup for a *different* execution
      // without the main page having set new data first (e.g. if main page crashes or hangs).
      // sessionStorage.removeItem(SESSION_STORAGE_KEY); 
    };
  }, []);

  if (error) {
    return (
      <div className="p-4 min-h-screen flex flex-col items-center justify-center">
        <Alert variant="destructive" className="w-full max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button onClick={() => window.close()} className="mt-4">Close</Button>
      </div>
    );
  }

  if (!execution) {
    return (
        <div className="p-4 min-h-screen flex flex-col items-center justify-center">
            <p>Loading execution details...</p>
        </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 bg-background text-foreground max-h-screen overflow-y-auto">
      <Card className="shadow-none border-0 md:border md:shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl md:text-2xl">Execution Details: {execution.executionId}</CardTitle>
          <CardDescription>
            Task ID: {execution.taskId} | Status: {execution.status} | LLM: {execution.llmName || 'N/A'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <h4 className="font-semibold text-sm mb-0.5">Execution Timings</h4>
            <p className="text-xs"><strong>Started:</strong> {formatDate(execution.startTime)}</p>
            <p className="text-xs"><strong>Completed:</strong> {formatDate(execution.completedAt)}</p>
          </div>

          <Separator />

          <div>
            <h4 className="font-semibold text-sm mb-0.5">Prompt</h4>
            <pre className="bg-muted p-2 rounded-md text-xs whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {execution.prompt}
            </pre>
          </div>

          <Separator />

          <div>
            <h4 className="font-semibold text-sm mb-0.5">Result</h4>
            <div className="prose prose-sm dark:prose-invert max-w-none p-2 rounded-md bg-muted max-h-96 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {execution.result}
              </ReactMarkdown>
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="text-center pt-2">
        <Button onClick={() => window.close()}>Close Window</Button>
      </div>
    </div>
  );
};

export default ExecutionDetailPopupPage; 