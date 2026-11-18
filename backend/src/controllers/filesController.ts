import { Request, Response } from "express";
import {
  uploadFileToS3WithPath,
  sanitizeS3Filename,
  extractS3KeyFromUrl,
  generatePresignedUrl,
  getS3ObjectStream,
  getS3ObjectMetadata,
} from "../utils/s3Utils";
import { ChatbotDB } from "../services/chatbotService";
import { AuthenticatedRequest, isRealAdmin } from "../middleware/auth";
import {
  canonicalStorageKey,
  decideStorageAccess,
  StorageAccess,
  StorageAccessLookups,
  StorageCaller,
  StorageDecision,
} from "../services/storageAccessPolicy";
import { renderHtmlToPdf } from "../services/pdfRenderService";

const DEFAULT_BUCKET = process.env.AWS_S3_BUCKET || "agentweb-user-files";

/**
 * ENG-2988: who is asking. A delegated session is its target user and has no admin power (isRealAdmin), and neither does an in-process tool
 * call (a self-call token can carry isAdmin for a delegated session).
 */
function storageCallerOf(req: Request): StorageCaller | null {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  return userId ? { userId, isRealAdmin: isRealAdmin(req) && !authReq.isSelfCall } : null;
}

/**
 * The one check every file route here runs, on the exact key it will sign, read or write. `canonical` is null when the reference is not a
 * single well-formed key. Denials are logged by kind and reason (never the key) so a legitimate flow that was missed shows up in the logs.
 */
async function authorizeStorageKey(
  route: string,
  caller: StorageCaller,
  canonical: string | null,
  access: StorageAccess,
  lookups: StorageAccessLookups,
): Promise<StorageDecision> {
  if (!canonical) return { allow: false, reason: 'invalid_key', shape: 'invalid' };
  const decision = await decideStorageAccess(caller, canonical, access, lookups);
  if (!decision.allow) {
    console.warn(JSON.stringify({ event: 'storage_access_denied', route, access, shape: decision.shape, reason: decision.reason, userId: caller.userId }));
  }
  return decision;
}

const FILE_NOT_FOUND = { success: false, message: "File not found." };
const FILE_LOOKUP_FAILED = { success: false, message: "Could not check access to this file right now. Please try again." };
const FILE_READ_ONLY = { success: false, message: "You can view this file, but only its owner can change it." };

/** The answer for a refused file request: "try again" when the check itself could not run, otherwise the same as a missing file. */
function sendFileRefusal(res: Response, decision: StorageDecision) {
  if (!decision.allow && decision.reason === "lookup_failed") return res.status(503).json(FILE_LOOKUP_FAILED);
  return res.status(404).json(FILE_NOT_FOUND);
}

/**
 * Sanitize a caller-supplied download filename for use inside an HTTP
 * `Content-Disposition` header. Strips path separators and quote characters (the
 * two ways a raw filename could escape the `filename="..."` quoting and either
 * break the header or, for path separators, be misread by some clients as a
 * path), replacing them with `_`; anything left empty falls back to a generic
 * name.
 */
function sanitizeDownloadFilename(filename: unknown): string {
  const raw = typeof filename === 'string' ? filename.trim() : '';
  // CodeRabbit (ENG-1188): RFC 9110 forbids CR/LF/NUL/other C0 controls and DEL
  // in a header field value -- left unstripped, S3 can reject the presigned
  // request (InvalidRequest) or inject characters into the response header.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f/\\":;]/g, '_');
  return cleaned.length > 0 ? cleaned : 'download';
}

/**
 * Generate a presigned URL for an S3 file.
 * Accepts either a public S3 URL or an S3 key via query parameter.
 * Returns a time-limited presigned URL for direct browser access.
 *
 * ENG-1188: `download=true` additionally bakes an `attachment` disposition into
 * the presigned URL (optionally with `filename`) so the response forces a real
 * download instead of the browser rendering/displaying the object inline — the
 * generated ad-creative assets (HTML banners, screenshots) had no working
 * download path; "open in new tab" just opened them as a live page/image.
 */
export const getPresignedFileUrl = async (req: Request, res: Response) => {
  const { url, key, download, filename } = req.query;

  if (!url && !key) {
    return res.status(400).json({
      success: false,
      message: "Either 'url' or 'key' query parameter is required.",
    });
  }

  try {
    const caller = storageCallerOf(req);
    if (!caller) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    let canonical: string | null = null;

    if (key && typeof key === "string") {
      canonical = canonicalStorageKey(key, "key");
    } else if (url && typeof url === "string") {
      const fromUrl = extractS3KeyFromUrl(url, DEFAULT_BUCKET);
      if (!fromUrl) {
        return res.status(400).json({
          success: false,
          message: "URL does not reference a file in the configured S3 bucket.",
        });
      }
      canonical = canonicalStorageKey(fromUrl, "url-path");
    } else {
      return res.status(400).json({
        success: false,
        message: "Could not determine S3 key.",
      });
    }

    // ENG-2988: this used to sign any key for any signed-in user. The check runs on the exact string that is signed below.
    const decision = await authorizeStorageKey("presign", caller, canonical, "read", new StorageAccessLookups());
    if (!decision.allow || !canonical) {
      return sendFileRefusal(res, decision);
    }

    const wantsDownload = download === "true" || download === "1";
    const responseContentDisposition = wantsDownload
      ? `attachment; filename="${sanitizeDownloadFilename(filename)}"`
      : undefined;

    const presignedUrl = generatePresignedUrl(
      canonical,
      DEFAULT_BUCKET,
      undefined,
      responseContentDisposition
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
    const caller = storageCallerOf(req);
    if (!caller) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // ENG-2988: same check as the single presign, per entry; an entry the caller may not read is left out, like a URL outside the bucket.
    const lookups = new StorageAccessLookups();
    const result: Record<string, string> = {};
    for (const originalUrl of urls) {
      if (typeof originalUrl !== "string") continue;
      const fromUrl = extractS3KeyFromUrl(originalUrl, DEFAULT_BUCKET);
      if (!fromUrl) continue;
      const canonical = canonicalStorageKey(fromUrl, "url-path");
      const decision = await authorizeStorageKey("presign-batch", caller, canonical, "read", lookups);
      if (!decision.allow || !canonical) continue;
      result[originalUrl] = generatePresignedUrl(canonical, DEFAULT_BUCKET);
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
    const fromUrl = extractS3KeyFromUrl(url, DEFAULT_BUCKET);

    if (fromUrl) {
      const caller = storageCallerOf(req);
      if (!caller) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
      // ENG-2988: this used to return any object of the bucket to any signed-in user.
      const s3Key = canonicalStorageKey(fromUrl, "url-path");
      const decision = await authorizeStorageKey("content", caller, s3Key, "read", new StorageAccessLookups());
      if (!decision.allow || !s3Key) {
        return sendFileRefusal(res, decision);
      }
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
    // (the address is not logged: it carries the file's key, and may carry a signature)
    console.error("Error fetching file content:", error.message);

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

  const fromUrl = extractS3KeyFromUrl(url, DEFAULT_BUCKET);
  if (!fromUrl) {
    return res.status(400).json({
      success: false,
      message: "URL must reference a file in the configured S3 bucket.",
    });
  }

  try {
    const caller = storageCallerOf(req);
    if (!caller) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const requestedKey = canonicalStorageKey(fromUrl, "url-path");
    if (!requestedKey) {
      return res.status(404).json(FILE_NOT_FOUND);
    }

    const lastSlashIndex = requestedKey.lastIndexOf("/");
    const filename =
      lastSlashIndex === -1 ? requestedKey : requestedKey.substring(lastSlashIndex + 1);
    const path = lastSlashIndex === -1 ? "" : requestedKey.substring(0, lastSlashIndex);

    // ENG-2988: this used to overwrite any object of the bucket for any signed-in user. Only the owner (or a real admin) may write.
    // The upload rewrites the file name (non-ASCII and other characters become `_`), so the key that is authorised is the one it will
    // actually write: the directory as given plus the sanitised name.
    const writeKey = canonicalStorageKey(path ? `${path}/${sanitizeS3Filename(filename)}` : sanitizeS3Filename(filename), "decoded");
    const lookups = new StorageAccessLookups();
    const decision = await authorizeStorageKey("html", caller, writeKey, "write", lookups);
    if (!decision.allow || !writeKey) {
      // A teammate who may open the file but not change it is told so; anyone else gets the same answer as for a file that does not exist.
      if (!decision.allow && decision.reason !== "lookup_failed" && writeKey && (await decideStorageAccess(caller, writeKey, "read", lookups)).allow) {
        return res.status(403).json(FILE_READ_ONLY);
      }
      return sendFileRefusal(res, decision);
    }

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
