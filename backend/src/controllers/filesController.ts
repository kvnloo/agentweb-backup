import { Request, Response } from "express";
import http from "http"; // Import Node.js http module
import https from "https"; // Import Node.js https module
import axios from "axios";
import path from "path";
import {
  uploadFileToS3WithPath,
  extractS3KeyFromUrl,
  presignS3Url,
  getS3ObjectStream,
  getS3ObjectMetadata,
} from "../utils/s3Utils";
import { ChatbotDB } from "../services/chatbotService";
import { AuthenticatedRequest } from "../middleware/auth";
import { renderHtmlToPdf } from "../services/pdfRenderService";

const DEFAULT_BUCKET = process.env.AWS_S3_BUCKET || "agentweb-user-files";

export const viewExternalFile = async (req: Request, res: Response) => {
  const { url } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({
      message: "URL query parameter is required and must be a string.",
    });
  }

  try {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res
        .status(400)
        .json({ message: "Invalid URL format. Must be HTTP or HTTPS." });
    }

    // If it's an S3 URL for our bucket, stream directly via SDK (no public access needed)
    const s3Key = extractS3KeyFromUrl(url, DEFAULT_BUCKET);
    if (s3Key) {
      try {
        const metadata = await getS3ObjectMetadata(s3Key, DEFAULT_BUCKET);
        const contentType = metadata.ContentType || "text/html; charset=utf-8";
        res.setHeader("Content-Type", contentType);
        if (metadata.ContentLength) {
          res.setHeader("Content-Length", metadata.ContentLength);
        }
        const stream = getS3ObjectStream(s3Key, DEFAULT_BUCKET);
        stream.on("error", (err) => {
          console.error(`Error streaming S3 object ${s3Key}:`, err.message);
          if (!res.headersSent) {
            res.status(500).send("Error streaming file content.");
          }
        });
        stream.pipe(res);
        return;
      } catch (s3Error: any) {
        const isNotFound = s3Error.code === "NoSuchKey" || s3Error.statusCode === 404;
        if (!res.headersSent) {
          return res.status(isNotFound ? 404 : 500).json({
            message: isNotFound ? "File not found" : "Failed to retrieve file.",
          });
        }
        return;
      }
    }

    // Not an S3 URL — proxy via HTTP (for backward compatibility with non-S3 external files)
    const protocol = url.startsWith("https://") ? https : http;
    const requestOptions = { timeout: 10000 };

    const clientRequest = protocol.get(url, requestOptions, (proxyResponse) => {
      if (proxyResponse.statusCode !== 200) {
        console.error(
          `Error fetching external file from URL: ${url}. Status: ${proxyResponse.statusCode}`
        );
        proxyResponse.resume();
        if (proxyResponse.statusCode) {
          res.status(proxyResponse.statusCode);
        }
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
      clientRequest.destroy();
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
        res.status(502).json({
          message: "Error connecting to external file URL (Bad Gateway).",
        });
      }
    });
  } catch (error: any) {
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

/**
 * Generate a presigned URL for an S3 file.
 * Accepts either a public S3 URL or an S3 key via query parameter.
 * Returns a time-limited presigned URL for direct browser access.
 */
export const getPresignedFileUrl = async (req: Request, res: Response) => {
  const { url, key } = req.query;

  if (!url && !key) {
    return res.status(400).json({
      success: false,
      message: "Either 'url' or 'key' query parameter is required.",
    });
  }

  try {
    let s3Key: string | null = null;

    if (key && typeof key === "string") {
      s3Key = key;
    } else if (url && typeof url === "string") {
      s3Key = extractS3KeyFromUrl(url, DEFAULT_BUCKET);
      if (!s3Key) {
        return res.status(400).json({
          success: false,
          message: "URL does not reference a file in the configured S3 bucket.",
        });
      }
    }

    if (!s3Key) {
      return res.status(400).json({
        success: false,
        message: "Could not determine S3 key.",
      });
    }

    const presignedUrl = presignS3Url(
      `https://${DEFAULT_BUCKET}.s3.amazonaws.com/${s3Key}`,
      DEFAULT_BUCKET
    );

    if (!presignedUrl) {
      return res.status(500).json({
        success: false,
        message: "Failed to generate presigned URL.",
      });
    }

    return res.json({
      success: true,
      presignedUrl,
      expiresIn: 3600,
    });
  } catch (error: any) {
    console.error("Error generating presigned URL:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to generate presigned URL.",
      error: error.message,
    });
  }
};

/**
 * Batch generate presigned URLs for multiple S3 files.
 * Accepts an array of public S3 URLs in the request body.
 * Returns a map of original URL -> presigned URL.
 */
export const batchPresignUrls = async (req: Request, res: Response) => {
  const { urls } = req.body as { urls?: string[] };

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({
      success: false,
      message: "'urls' must be a non-empty array of S3 URLs.",
    });
  }

  if (urls.length > 50) {
    return res.status(400).json({
      success: false,
      message: "Maximum 50 URLs per batch request.",
    });
  }

  try {
    const result: Record<string, string> = {};
    for (const originalUrl of urls) {
      if (typeof originalUrl !== "string") continue;
      const presigned = presignS3Url(originalUrl, DEFAULT_BUCKET);
      if (presigned) {
        result[originalUrl] = presigned;
      }
    }

    return res.json({
      success: true,
      urls: result,
      expiresIn: 3600,
    });
  } catch (error: any) {
    console.error("Error batch generating presigned URLs:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to generate presigned URLs.",
      error: error.message,
    });
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
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res
        .status(400)
        .json({ message: "Invalid URL format. Must be HTTP or HTTPS." });
    }

    // Try to extract S3 key — if it's our bucket, read directly via SDK (no public access needed)
    const s3Key = extractS3KeyFromUrl(url, DEFAULT_BUCKET);

    if (s3Key) {
      // Use S3 SDK directly — works even when public access is blocked
      const stream = getS3ObjectStream(s3Key, DEFAULT_BUCKET);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks).toString("utf-8");

      let contentType = "text/html";
      try {
        const metadata = await getS3ObjectMetadata(s3Key, DEFAULT_BUCKET);
        contentType = metadata.ContentType || contentType;
      } catch {
        // Fall back to text/html if HEAD fails
      }

      return res.json({
        success: true,
        content,
        contentLength: content.length,
        contentType,
      });
    }

    // Not an S3 URL for our bucket — block to prevent SSRF
    return res.status(403).json({
      success: false,
      message: "Access denied: URL must reference a file in the configured S3 bucket.",
    });
  } catch (error: any) {
    console.error(
      `Error fetching file content from URL: ${url}`,
      error.message
    );

    const isNotFound = error.code === "NoSuchKey" || error.statusCode === 404;
    return res.status(isNotFound ? 404 : 500).json({
      success: false,
      message: isNotFound ? "File not found" : "Failed to fetch file content",
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

  const key = extractS3KeyFromUrl(url, DEFAULT_BUCKET);
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

    // Invalidate cached searchableText — the file content changed but URL is the same
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (userId) {
      new ChatbotDB().clearSearchableTextByUrl(userId, url).catch(() => {/* non-critical */});
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

export const exportHtmlToPdf = async (req: Request, res: Response) => {
  const { html, filename, orientation, format } = req.body as {
    html?: string;
    filename?: string;
    orientation?: "portrait" | "landscape" | "auto";
    format?: string;
  };

  if (!html || typeof html !== "string") {
    return res.status(400).json({ success: false, message: "html is required and must be a string." });
  }

  const safeFilename = (filename || "export").replace(/[^a-zA-Z0-9_\-]/g, "_").replace(/\.html$/i, "") + ".pdf";

  try {
    // Shared render path (orientation auto-detection + fit-to-width + overlap fix).
    const { buffer } = await renderHtmlToPdf({
      html,
      orientation: orientation ?? "auto",
      format,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.send(buffer);
  } catch (error: any) {
    console.error("Error generating PDF:", error);
    return res.status(500).json({ success: false, message: "Failed to generate PDF.", error: error.message });
  }
};
