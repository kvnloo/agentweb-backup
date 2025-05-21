import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import DOMPurify from "dompurify";
import { useAuth } from "@/contexts/AuthContext";
import { buildApiUrl } from "@/config";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Define interfaces based on the example provided
interface ResultFile {
  view_type: string;
  filename: string;
  url: string;
  token: string; // Assuming token might be needed for direct access if not proxied
}

interface Execution {
  taskId: string;
  llmName: string;
  executionId: string;
  status: string;
  result?: string; // Result can be optional if file is primary
  result_files?: ResultFile[];
  startTime: string;
  completedAt?: string;
  userId: string;
  details_gif?: string;
  outputAsJson?: boolean;
  prompt: string;
  browser_use_log?: string;
}

// Interface for the parent task details
interface ParentTask {
  name: string;
  // Add other task fields if needed for future use
}

// Helper function for formatting dates (copied from TaskDetailsPage.tsx)
const formatDate = (dateStr?: string) => {
  if (!dateStr) return "N/A";
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      const parts = dateStr.match(
        /(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):?(\d{2}))?/
      );
      if (parts) {
        const isoStr = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${
          parts[5]
        }:${parts[6]}${parts[7] || "Z"}`;
        const parsedDate = new Date(isoStr);
        if (!isNaN(parsedDate.getTime())) return parsedDate.toLocaleString();
      }
      return "Invalid Date";
    }
    return date.toLocaleString();
  } catch (e) {
    return "Invalid Date";
  }
};

const ExecutionResultPage = () => {
  const { taskId, executionId } = useParams<{
    taskId: string;
    executionId: string;
  }>();
  const navigate = useNavigate();
  const { token } = useAuth();
  const [execution, setExecution] = useState<Execution | null>(null);
  const [taskName, setTaskName] = useState<string | null>(null); // Added state for task name
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId || !executionId || !token) {
      setError("Task ID, Execution ID, or authentication token is missing.");
      setIsLoading(false);
      return;
    }

    const fetchDetails = async () => {
      setIsLoading(true);
      setError(null);
      try {
        // Fetch execution details
        const executionResponse = await axios.get<Execution[]>(
          buildApiUrl(`/api/tasks/${taskId}/executions`),
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        const currentExecution = executionResponse.data.find(
          (ex) => ex.executionId === executionId
        );

        if (!currentExecution) {
          setError("Execution not found.");
          setIsLoading(false);
          return;
        }
        setExecution(currentExecution);

        // Fetch parent task details for the name
        try {
          const taskResponse = await axios.get<ParentTask>(
            buildApiUrl(`/api/tasks/${taskId}`),
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          setTaskName(taskResponse.data.name);
        } catch (taskErr) {
          console.error("Failed to fetch task name:", taskErr);
          // Not setting a blocking error, header will have a fallback
        }

        const htmlFile = currentExecution.result_files?.find(
          (file) => file.view_type === "html" && file.filename.endsWith(".html")
        );

        if (htmlFile && htmlFile.url) {
          try {
            const fileContentResponse = await axios.get<string>(
              buildApiUrl(
                `/api/files/view-external?url=${encodeURIComponent(
                  htmlFile.url
                )}`
              ),
              { responseType: "text" }
            );
            // Sanitize the fetched HTML
            let sanitizedHtml = DOMPurify.sanitize(fileContentResponse.data);

            // Check if the parent document is in dark mode and inject styles if necessary
            if (document.documentElement.classList.contains("dark")) {
              const darkModeStyles = `
                <style>
                  body {
                    background-color: #1e293b; /* slate-800 */
                    color: #f8fafc; /* slate-50 */
                  }
                  /* Add more specific dark mode styles if needed */
                  a { color: #94a3b8; } /* slate-400 */
                </style>
              `;
              // Prepend styles to the head or body if they exist, otherwise just prepend
              if (sanitizedHtml.includes("<head>")) {
                sanitizedHtml = sanitizedHtml.replace(
                  "<head>",
                  "<head>" + darkModeStyles
                );
              } else if (sanitizedHtml.includes("<body>")) {
                sanitizedHtml = sanitizedHtml.replace(
                  "<body>",
                  "<body>" + darkModeStyles
                );
              } else {
                sanitizedHtml = darkModeStyles + sanitizedHtml;
              }
            }

            // Ensure links in the HTML open in a new tab
            try {
              const parser = new DOMParser();
              // Parse the potentially style-injected HTML
              const tempDoc = parser.parseFromString(
                sanitizedHtml,
                "text/html"
              );
              const links = tempDoc.querySelectorAll("a");
              links.forEach((link) => {
                const href = link.getAttribute("href");
                if (href && !href.startsWith("#")) {
                  link.setAttribute("target", "_blank");
                  link.setAttribute("rel", "noopener");
                }
              });
              // Re-serialize the *entire modified document* to preserve head/styles
              sanitizedHtml = tempDoc.documentElement.outerHTML;
            } catch (domError) {
              console.error("Error processing HTML links:", domError);
            }

            setHtmlContent(sanitizedHtml);
          } catch (fileError) {
            console.error("Error fetching HTML file content:", fileError);
            setError(
              "Failed to load HTML file content. Displaying text result instead."
            );
          }
        }
      } catch (err) {
        console.error("Error fetching execution details:", err);
        setError(
          err.response?.data?.message || "Failed to load execution details."
        );
      }
      setIsLoading(false);
    };

    fetchDetails();
  }, [taskId, executionId, token]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="ml-4 text-lg">Loading execution result...</p>
      </div>
    );
  }

  if (error && !htmlContent && !execution?.result) {
    // Show critical error only if nothing else to display
    return (
      <div className="container mx-auto p-4">
        <Button
          className="secondary-button"
          size="sm"
          onClick={() => navigate(`/tasks/${taskId}`)}
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Task Details
        </Button>
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Display error as a non-critical message if there's other content (like text result after HTML fetch fail)
  const renderErrorAlert = () => {
    if (error && (htmlContent || execution?.result)) {
      return (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Notice</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      );
    }
    return null;
  };

  return (
    <div className="container mx-auto p-4 space-y-4">
      <Button
        className="secondary-button"
        size="sm"
        onClick={() => navigate(`/tasks/${taskId}`)}
      >
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to Task Details
      </Button>
      <Card>
        <CardHeader>
          <CardTitle>{taskName || "Execution Result"}</CardTitle>
          <CardDescription>
            {execution?.completedAt
              ? `Completed: ${formatDate(execution.completedAt)}`
              : `Status: ${execution?.status || "Unknown"}`}
            {executionId && ` (ID: ${executionId})`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {renderErrorAlert()}
          {htmlContent ? (
            <iframe
              srcDoc={htmlContent}
              title="Execution Result HTML"
              style={{ width: "100%", height: "600px", border: "none" }}
              sandbox="allow-same-origin allow-scripts allow-popups"
            />
          ) : execution?.result ? (
            <div className="prose dark:prose-invert max-w-none p-4 rounded-md bg-muted dark:bg-slate-900/50">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {execution.result}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No result content available for this execution.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ExecutionResultPage;
