import { Router, Response } from "express";
import AWS from "aws-sdk";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import {
  addSubdomain,
  addCustomDomain,
  removeDomain,
  listDomains,
  getDomain,
  verifyDomain,
} from "../services/customDomainService";
import { userHasFeature } from "../services/subscriptionService";
import { authorizeLandingPageAccess } from "./landingPageGeneration";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
});
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const LANDING_PAGES_TABLE = `${TABLE_PREFIX}AW-LandingPages`;

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/domains
 * List all custom domains for the current user.
 * Optional query param: ?projectId=xxx to filter by Vercel project.
 */
router.get("/", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const projectId = req.query.projectId as string | undefined;
    const domains = await listDomains(userId, projectId);
    res.json({ domains });
  } catch (error: any) {
    console.error("[DOMAINS] Error listing domains:", error);
    res.status(500).json({ error: "Failed to list domains" });
  }
});

/**
 * GET /api/domains/:id
 * Get a specific domain record.
 */
router.get("/:id", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const domain = await getDomain(req.params.id, userId);
    if (!domain) return res.status(404).json({ error: "Domain not found" });

    res.json(domain);
  } catch (error: any) {
    console.error("[DOMAINS] Error getting domain:", error);
    res.status(500).json({ error: "Failed to get domain" });
  }
});

/**
 * POST /api/domains/subdomain
 * Add a subdomain (e.g., mysite.agentwebforms.com) to a landing page project.
 */
router.post("/subdomain", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { vercelProjectId, subdomain, landingPageId } = req.body;
    if (!vercelProjectId || typeof vercelProjectId !== "string") {
      return res.status(400).json({ error: "vercelProjectId is required" });
    }
    if (!subdomain || typeof subdomain !== "string") {
      return res.status(400).json({ error: "subdomain is required" });
    }

    const result = await addSubdomain(userId, vercelProjectId, subdomain);

    // If a landing page ID was provided, persist customDomainUrl on the record.
    // For sub-pages (those with a slug), the URL must include the slug path.
    // This is non-fatal: if it fails (e.g. ConditionalCheckFailed), the subdomain
    // was still successfully added to Vercel, so we return 201 regardless.
    if (landingPageId && typeof landingPageId === "string") {
      try {
        // Fetch the page to check for a slug (sub-pages need /{slug} appended)
        const pageResult = await dynamodb.get({
          TableName: LANDING_PAGES_TABLE,
          Key: { id: landingPageId },
        }).promise();
        const slug = pageResult.Item?.slug;
        const customDomainUrl = slug
          ? `https://${result.domain}/${slug}`
          : `https://${result.domain}`;

        await dynamodb.update({
          TableName: LANDING_PAGES_TABLE,
          Key: { id: landingPageId },
          ConditionExpression: "userId = :uid",
          UpdateExpression: "SET customDomainUrl = :url, updatedAt = :now",
          ExpressionAttributeValues: {
            ":url": customDomainUrl,
            ":uid": userId,
            ":now": new Date().toISOString(),
          },
        }).promise();
      } catch (updateErr: any) {
        console.error("[DOMAINS] Failed to persist customDomainUrl on landing page:", updateErr?.message);
      }
    }

    res.status(201).json(result);
  } catch (error: any) {
    console.error("[DOMAINS] Error adding subdomain:", error);
    const status = error.message?.includes("Invalid") ? 400 : 500;
    res.status(status).json({ error: error.message || "Failed to add subdomain" });
  }
});

/**
 * POST /api/domains/custom
 * Add a custom domain to a landing page project.
 */
router.post("/custom", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Payload validation FIRST — keeps 400 errors as 400 (not 403) for malformed requests
    const { vercelProjectId, domain, landingPageId } = req.body;
    if (!vercelProjectId || typeof vercelProjectId !== "string") {
      return res.status(400).json({ error: "vercelProjectId is required" });
    }
    if (!domain || typeof domain !== "string") {
      return res.status(400).json({ error: "domain is required" });
    }

    // Tier gate
    const ok = await userHasFeature(userId, "custom-domain");
    if (!ok) {
      return res.status(403).json({ error: "Custom domains require a higher-tier subscription" });
    }

    // Landing page ownership
    if (landingPageId && typeof landingPageId === "string") {
      const auth = await authorizeLandingPageAccess(landingPageId, userId, "edit");
      if (!auth.ok) {
        return res.status(auth.status).json({ error: auth.error });
      }
    }

    const result = await addCustomDomain(
      userId,
      vercelProjectId,
      domain,
      landingPageId && typeof landingPageId === "string" ? landingPageId : undefined
    );
    res.status(201).json(result);
  } catch (error: any) {
    console.error("[DOMAINS] Error adding custom domain:", error);
    const status = error.message?.includes("Invalid") ? 400 : 500;
    res.status(status).json({ error: error.message || "Failed to add custom domain" });
  }
});

/**
 * DELETE /api/domains/:id
 * Remove a domain from the project and DNS.
 */
router.delete("/:id", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    await removeDomain(req.params.id, userId);
    res.json({ message: "Domain removed successfully" });
  } catch (error: any) {
    console.error("[DOMAINS] Error removing domain:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to remove domain" });
  }
});

/**
 * POST /api/domains/:id/verify
 * Check DNS verification status for a custom domain.
 */
router.post("/:id/verify", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const result = await verifyDomain(req.params.id, userId);
    res.json(result);
  } catch (error: any) {
    console.error("[DOMAINS] Error verifying domain:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to verify domain" });
  }
});

export default router;
