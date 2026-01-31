import { Request, Response } from "express";
import http from "http"; // Import Node.js http module
import https from "https"; // Import Node.js https module
import axios from "axios";
import { uploadFileToS3WithPath } from "../utils/s3Utils";

const DEFAULT_BUCKET = process.env.AWS_S3_BUCKET || "agentweb-user-files";

const extractS3Key = (fileUrl: string, bucket: string): string | null => {
  try {
    const url = new URL(fileUrl);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+/, "");

    if (host.startsWith(`${bucket}.`)) {
      return path || null;
    }

    if (path.startsWith(`${bucket}/`)) {
      return path.substring(bucket.length + 1) || null;
    }

    return null;
  } catch (error) {
    console.error("Error parsing S3 URL:", error);
    return null;
  }
};

export const viewExternalFile = async (req: Request, res: Response) => {
  const { url } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({
      message: "URL query parameter is required and must be a string.",
    });
  }

  try {
    // Validate the URL to ensure it's an HTTP/HTTPS URL (basic validation)
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res
        .status(400)
        .json({ message: "Invalid URL format. Must be HTTP or HTTPS." });
    }

    const protocol = url.startsWith("https://") ? https : http;
    const requestOptions = { timeout: 10000 }; // 10 seconds timeout

    const clientRequest = protocol.get(url, requestOptions, (proxyResponse) => {
      if (proxyResponse.statusCode !== 200) {
        console.error(
          `Error fetching external file from URL: ${url}. Status: ${proxyResponse.statusCode}`
        );
        proxyResponse.resume(); // Consume response data to free up memory
        // Avoid sending JSON error for non-200, as the original server might have sent a specific error page
        // We will just forward the status and let the client handle it if it's not HTML
        if (proxyResponse.statusCode) {
          res.status(proxyResponse.statusCode);
        }
        // Try to pipe the error response body if any
        proxyResponse.pipe(res).on("error", (pipeError) => {
          console.error("Error piping error response:", pipeError);
          if (!res.headersSent) {
            res
              .status(proxyResponse.statusCode || 500)
              .send("Failed to retrieve file from external URL.");
          }
        });
        return;
      }

      // Forward the Content-Type from the source if available, otherwise default to text/html
      const contentType =
        proxyResponse.headers["content-type"] || "text/html; charset=utf-8";
      res.setHeader("Content-Type", contentType);

      proxyResponse.pipe(res).on("error", (pipeError) => {
        console.error(`Error piping data from URL ${url}:`, pipeError);
        if (!res.headersSent) {
          res.status(500).send("Error streaming file content.");
        }
      });
    });

    clientRequest.on("timeout", () => {
      clientRequest.destroy(); // Destroy the request to prevent further data processing
      console.error(`Timeout fetching external file from URL: ${url}`);
      if (!res.headersSent) {
        res.status(504).json({
          message:
            "Error fetching file: Gateway timeout while connecting to external URL.",
        });
      }
    });

    clientRequest.on("error", (e: Error) => {
      console.error(`Error making request to external URL ${url}:`, e.message);
      if (!res.headersSent) {
        // Check if headers haven't been sent yet
        res.status(502).json({
          message: "Error connecting to external file URL (Bad Gateway).",
        }); // 502 for network errors connecting to upstream
      }
    });
  } catch (error: any) {
    // This catch block is for synchronous errors in the setup, not for the async http.get errors
    console.error(
      `Unexpected error in viewExternalFile for URL: ${url}`,
      error.message
    );
    if (!res.headersSent) {
      res.status(500).json({
        message:
          "Internal server error while attempting to fetch external file.",
        error: error.message,
      });
    }
  }
};

export const getFileContent = async (req: Request, res: Response) => {
  const { url } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({
      message: "URL query parameter is required and must be a string.",
    });
  }

  try {
    // Validate the URL to ensure it's an HTTP/HTTPS URL
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res
        .status(400)
        .json({ message: "Invalid URL format. Must be HTTP or HTTPS." });
    }

    // Security: Allowlist of permitted domains to prevent SSRF
    const allowedDomains = [
      "agentweb-user-files.s3.us-west-2.amazonaws.com",
      "agentweb-user-files.s3.amazonaws.com",
    ];

    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      const isAllowed = allowedDomains.some(domain => hostname === domain.toLowerCase());

      if (!isAllowed) {
        console.log(`🚫 Blocked request to unauthorized domain: ${hostname}`);
        return res.status(403).json({
          success: false,
          message: "Access denied: URL domain not in allowlist",
        });
      }
    } catch (urlError) {
      return res.status(400).json({
        success: false,
        message: "Invalid URL format",
      });
    }

    console.log(`🔽 Fetching file content from: ${url}`);

    // Fetch the file content using axios
    const response = await axios.get(url, {
      timeout: 15000, // 15 seconds timeout
      responseType: "text",
      headers: {
        "User-Agent": "AgentWeb-Backend/1.0",
      },
    });

    const content = response.data as string;
    console.log(
      `✅ Successfully fetched file content, length: ${content.length}`
    );

    return res.json({
      success: true,
      content: content,
      contentLength: content.length,
      contentType: response.headers["content-type"],
    });
  } catch (error: any) {
    console.error(
      `❌ Error fetching file content from URL: ${url}`,
      error.message
    );

    let errorMessage = "Failed to fetch file content";
    let statusCode = 500;

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
    } else if (error.code === "ENOTFOUND") {
      statusCode = 404;
      errorMessage = "File not found or URL is unreachable";
    } else if (error.code === "ETIMEDOUT") {
      statusCode = 408;
      errorMessage = "Request timeout while fetching file";
    }

    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: error.message,
    });
  }
};

export const saveHtmlContent = async (req: Request, res: Response) => {
  const { url, content } = req.body as { url?: string; content?: string };

  if (!url || typeof url !== "string") {
    return res.status(400).json({
      success: false,
      message: "url is required and must be a string.",
    });
  }

  if (typeof content !== "string") {
    return res.status(400).json({
      success: false,
      message: "content is required and must be a string.",
    });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return res.status(400).json({
      success: false,
      message: "Invalid URL format. Must be HTTP or HTTPS.",
    });
  }

  const key = extractS3Key(url, DEFAULT_BUCKET);
  if (!key) {
    return res.status(400).json({
      success: false,
      message: "URL must reference a file in the configured S3 bucket.",
    });
  }

  const lastSlashIndex = key.lastIndexOf("/");
  const filename =
    lastSlashIndex === -1 ? key : key.substring(lastSlashIndex + 1);
  const path = lastSlashIndex === -1 ? "" : key.substring(0, lastSlashIndex);

  try {
    const uploadResult = await uploadFileToS3WithPath(
      content,
      filename,
      "text/html",
      path
    );

    if (!uploadResult.success || !uploadResult.url) {
      return res.status(500).json({
        success: false,
        message: uploadResult.error || "Failed to save HTML content.",
      });
    }

    return res.json({
      success: true,
      url: uploadResult.url,
      key: uploadResult.key,
      filename,
    });
  } catch (error: any) {
    console.error("Error saving HTML content:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save HTML content.",
      error: error.message,
    });
  }
};
