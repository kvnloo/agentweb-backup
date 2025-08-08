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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  const [tabbedFiles, setTabbedFiles] = useState<ResultFile[]>([]);
  const [primaryHtmlFileInfo, setPrimaryHtmlFileInfo] = useState<{
    url: string;
    filename: string;
  } | null>(null); // Added
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

        const allResultFiles = currentExecution.result_files || []; // Added
        const primaryHtmlFile = allResultFiles.find(
          // Changed: use allResultFiles
          (file) => file.view_type === "html" && file.filename.endsWith(".html")
        );

        // Set files for tabs (all non-primary HTML files, and other types)
        setTabbedFiles(
          allResultFiles.filter((file) => file !== primaryHtmlFile)
        ); // Added

        if (primaryHtmlFile && primaryHtmlFile.url) {
          // Changed: use primaryHtmlFile
          try {
            const fileContentResponse = await axios.get<string>(
              buildApiUrl(
                `/api/files/view-external?url=${encodeURIComponent(
                  primaryHtmlFile.url
                )}`
              ),
              { responseType: "text" }
            );
            // Get the raw HTML content
            let rawHtml = fileContentResponse.data;

            setHtmlContent(rawHtml);

            if (primaryHtmlFile) {
              setPrimaryHtmlFileInfo({
                url: primaryHtmlFile.url,
                filename: primaryHtmlFile.filename,
              });
            }
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
            <>
              {primaryHtmlFileInfo && (
                <div className="mb-2 flex justify-end">
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href={primaryHtmlFileInfo.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={primaryHtmlFileInfo.filename}
                    >
                      Download HTML
                    </a>
                  </Button>
                </div>
              )}
              <iframe
                srcDoc={htmlContent}
                title="Execution Result HTML"
                style={{ 
                  width: "100%", 
                  height: "600px", 
                  border: "none",
                  backgroundColor: "white"
                }}
                sandbox="allow-scripts"
              />
            </>
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

          {/* Display other result files in Tabs */}
          {tabbedFiles.length > 0 && ( // Changed: Use tabbedFiles
            <div className="mt-6 pt-4 border-t">
              <h4 className="text-md font-semibold mb-3">Additional Files:</h4>
              <Tabs defaultValue={tabbedFiles[0].filename} className="w-full">
                <TabsList className="grid w-full grid-cols-none sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1 h-auto mb-2">
                  {tabbedFiles.map((file, index) => (
                    <TabsTrigger
                      key={index}
                      value={file.filename}
                      className="text-xs px-2 py-1.5 h-auto truncate"
                    >
                      {file.filename}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {tabbedFiles.map((file, index) => {
                  const isHtml =
                    file.filename.endsWith(".html") ||
                    file.view_type === "html";
                  const isImage = [
                    ".png",
                    ".jpg",
                    ".jpeg",
                    ".gif",
                    ".svg",
                  ].some((ext) => file.filename.toLowerCase().endsWith(ext));
                  return (
                    <TabsContent key={index} value={file.filename}>
                      <Card className="mt-2">
                        <CardHeader className="py-3 px-4 border-b">
                          <div className="flex justify-between items-center">
                            <CardTitle className="text-sm font-medium truncate">
                              {file.filename}
                            </CardTitle>
                            <Button variant="outline" size="sm" asChild>
                              <a
                                href={file.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Download
                              </a>
                            </Button>
                          </div>
                        </CardHeader>
                        <CardContent className="p-4 text-sm">
                          {isHtml ? (
                            <iframe
                              src={file.url} // Directly use the URL, assuming it's servable
                              title={`Preview: ${file.filename}`}
                              style={{
                                width: "100%",
                                height: "400px",
                                border: "1px solid #e2e8f0",
                              }}
                              sandbox="allow-same-origin allow-scripts" // Sandboxed for security
                            />
                          ) : isImage ? (
                            <img
                              src={file.url}
                              alt={`Preview: ${file.filename}`}
                              style={{
                                maxWidth: "100%",
                                maxHeight: "400px",
                                border: "1px solid #e2e8f0",
                                objectFit: "contain",
                              }}
                            />
                          ) : (
                            <p>
                              Preview not available for this file type. Please
                              download the file.
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    </TabsContent>
                  );
                })}
              </Tabs>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ExecutionResultPage;
