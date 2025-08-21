import { Request, Response } from "express";
import http from "http"; // Import Node.js http module
import https from "https"; // Import Node.js https module
import axios from "axios";

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
