import { Request, Response } from "express";
import crypto from "crypto";
import { extractS3KeyFromUrl, getS3ObjectStream, getS3ObjectMetadata } from "../utils/s3Utils";
import AWS from "aws-sdk";

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || "us-west-2",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// Allowed S3 buckets for asset serving
const ALLOWED_BUCKETS = new Set([
  process.env.AWS_S3_BUCKET || "agentweb-user-files",
  "agentweb-execution-gifs",
]);

// In-memory visit tracking: assetHash -> { count, ipHashes }
// Best-effort dedup by hashed IP; resets on server restart
interface VisitEntry {
  count: number;
  ipHashes: Set<string>;
  lastAccess: number;
}

const visitMap = new Map<string, VisitEntry>();

// Evict entries not accessed in 24 hours, run every hour
const EVICT_INTERVAL_MS = 60 * 60 * 1000;
const EVICT_TTL_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of visitMap) {
    if (now - entry.lastAccess > EVICT_TTL_MS) {
      visitMap.delete(key);
    }
  }
}, EVICT_INTERVAL_MS);

function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function trackVisit(assetHash: string, ip: string): { count: number; isNew: boolean } {
  const ipHash = hashIp(ip);
  let entry = visitMap.get(assetHash);
  if (!entry) {
    entry = { count: 0, ipHashes: new Set(), lastAccess: Date.now() };
    visitMap.set(assetHash, entry);
  }
  entry.lastAccess = Date.now();

  const isNew = !entry.ipHashes.has(ipHash);
  if (isNew) {
    entry.ipHashes.add(ipHash);
    entry.count++;
  }
  return { count: entry.count, isNew };
}

/**
 * Parse a base64url-encoded S3 URL, extract bucket and key, and validate.
 */
function decodeAssetHash(assetHash: string): { bucket: string; key: string } | null {
  try {
    // base64url -> base64
    const base64 = assetHash.replace(/-/g, "+").replace(/_/g, "/");
    const s3Url = Buffer.from(base64, "base64").toString("utf-8");

    // Must be an https S3 URL
    if (!s3Url.startsWith("https://")) {
      return null;
    }

    // Try each allowed bucket
    for (const bucket of ALLOWED_BUCKETS) {
      const key = extractS3KeyFromUrl(s3Url, bucket);
      if (key) {
        return { bucket, key };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GET /asset/:assetHash
 * Public endpoint that decodes a base64url S3 URL, streams the file content,
 * and tracks visits with best-effort IP dedup.
 */
export const serveAsset = async (req: Request, res: Response) => {
  const { assetHash } = req.params;
  if (!assetHash) {
    return res.status(400).send("Missing asset hash.");
  }

  const parsed = decodeAssetHash(assetHash);
  if (!parsed) {
    return res.status(400).send("Invalid asset hash.");
  }

  // Track visit (best effort, non-blocking for the response)
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  try {
    const { count, isNew } = trackVisit(assetHash, ip);
    if (isNew) {
      console.log(`[asset-visit] bucket=${parsed.bucket} key=${parsed.key} uniqueVisits=${count} ip_hash=${hashIp(ip)}`);
    }
  } catch (e) {
    // Best effort — don't fail the request
  }

  try {
    const headResult = await s3.headObject({ Bucket: parsed.bucket, Key: parsed.key }).promise();
    const contentType = headResult.ContentType || "text/html; charset=utf-8";
    res.setHeader("Content-Type", contentType);
    if (headResult.ContentLength) {
      res.setHeader("Content-Length", headResult.ContentLength);
    }
    // Cache for 5 minutes to reduce S3 load on repeated views
    res.setHeader("Cache-Control", "public, max-age=300");

    const stream = s3.getObject({ Bucket: parsed.bucket, Key: parsed.key }).createReadStream();
    stream.on("error", (err) => {
      console.error(`Error streaming asset ${parsed.key}:`, err.message);
      if (!res.headersSent) {
        res.status(500).send("Error streaming file.");
      }
    });
    stream.pipe(res);
  } catch (err: any) {
    const isNotFound = err.code === "NoSuchKey" || err.statusCode === 404;
    if (!res.headersSent) {
      return res.status(isNotFound ? 404 : 500).send(isNotFound ? "Not found." : "Error retrieving file.");
    }
  }
};

/**
 * GET /asset/:assetHash/stats
 * Returns visit stats for an asset.
 */
export const getAssetStats = async (req: Request, res: Response) => {
  const { assetHash } = req.params;
  if (!assetHash) {
    return res.status(400).json({ error: "Missing asset hash." });
  }

  const parsed = decodeAssetHash(assetHash);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid asset hash." });
  }

  const entry = visitMap.get(assetHash);
  return res.json({
    uniqueVisits: entry?.count || 0,
  });
};

// Exported for testing
export { decodeAssetHash, trackVisit, visitMap, hashIp };
