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
  getProjectDomain,
  getProjectSubdomain,
  setPageSubdomain,
  removePageSubdomainFromVercel,
} from "../services/customDomainService";
import { updateSubdomainMiddleware } from "../services/v0Service";

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
 * GET /api/domains/project-domain?vercelProjectId=xxx
 * Returns the active custom domain for a Vercel project, or null if none.
 * Must be registered before GET /:id to avoid param capture.
 */
router.get("/project-domain", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const vercelProjectId = req.query.vercelProjectId as string | undefined;
    if (!vercelProjectId) {
      return res.status(400).json({ error: "vercelProjectId query param is required" });
    }

    const record = await getProjectDomain(userId, vercelProjectId);
    res.json({ domain: record?.domain ?? null, status: record?.status ?? null });
  } catch (error: any) {
    console.error("[DOMAINS] Error getting project domain:", error);
    res.status(500).json({ error: "Failed to get project domain" });
  }
});

/**
 * GET /api/domains/project-subdomain?vercelProjectId=xxx
 * Returns the active subdomain record for a Vercel project, or null if none.
 * Must be registered before GET /:id to avoid param capture.
 */
router.get("/project-subdomain", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const vercelProjectId = req.query.vercelProjectId as string | undefined;
    if (!vercelProjectId) {
      return res.status(400).json({ error: "vercelProjectId query param is required" });
    }

    const record = await getProjectSubdomain(userId, vercelProjectId);
    if (record) {
      return res.json({ domain: record.domain, status: record.status, id: record.id });
    }

    // Fallback: users who set a per-page subdomain via POST /page-subdomain have
    // subdomainPrefix stored on the landing page record, not in AW-CustomDomains.
    const pagesResult = await dynamodb
      .query({
        TableName: LANDING_PAGES_TABLE,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :uid",
        FilterExpression: "vercelProjectId = :pid AND attribute_exists(subdomainPrefix)",
        ExpressionAttributeValues: { ":uid": userId, ":pid": vercelProjectId },
      })
      .promise();
    const pages = (pagesResult.Items || []) as any[];
    if (pages.length > 0) {
      const page = pages[0];
      let domain: string | null = null;
      if (page.customDomainUrl) {
        try {
          domain = new URL(page.customDomainUrl).host;
        } catch { /* ignore malformed URL */ }
      }
      return res.json({ domain, status: "active", id: null });
    }

    res.json({ domain: null, status: null, id: null });
  } catch (error: any) {
    console.error("[DOMAINS] Error getting project subdomain:", error);
    res.status(500).json({ error: "Failed to get project subdomain" });
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
        // Fetch the page to get slug and githubRepoUrl
        const pageResult = await dynamodb.get({
          TableName: LANDING_PAGES_TABLE,
          Key: { id: landingPageId },
        }).promise();
        const page = pageResult.Item as any;
        const slug = page?.slug as string | undefined;
        const githubRepoUrl = page?.githubRepoUrl as string | undefined;

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

        // Update GitHub middleware so the subdomain routes to the correct page path
        if (slug && githubRepoUrl) {
          const repoMatch = githubRepoUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\s|$)/);
          if (repoMatch) {
            // Build full domain map: existing agentwebforms subdomains + this new one
            const siblingPages = await dynamodb.query({
              TableName: LANDING_PAGES_TABLE,
              IndexName: "UserIdIndex",
              KeyConditionExpression: "userId = :uid",
              FilterExpression: "vercelProjectId = :pid AND attribute_exists(customDomainUrl) AND id <> :self",
              ExpressionAttributeValues: { ":uid": userId, ":pid": vercelProjectId, ":self": landingPageId },
            }).promise();

            const domainMap: Record<string, string> = {};
            for (const p of (siblingPages.Items || []) as any[]) {
              if (p.customDomainUrl && p.slug) {
                try {
                  const host = new URL(p.customDomainUrl).host;
                  domainMap[host] = `/${p.slug}`;
                } catch { /* skip malformed */ }
              }
            }
            domainMap[result.domain] = `/${slug}`;

            await updateSubdomainMiddleware(repoMatch[1], domainMap).catch((e: any) =>
              console.error("[DOMAINS] Failed to update middleware:", e?.message)
            );
          }
        }
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

    const { vercelProjectId, domain } = req.body;
    if (!vercelProjectId || typeof vercelProjectId !== "string") {
      return res.status(400).json({ error: "vercelProjectId is required" });
    }
    if (!domain || typeof domain !== "string") {
      return res.status(400).json({ error: "domain is required" });
    }

    const result = await addCustomDomain(userId, vercelProjectId, domain);
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

/**
 * POST /api/domains/page-subdomain
 * Set a subdomain prefix for a landing page.
 * Body: { vercelProjectId, landingPageId, subdomainPrefix, mainDomain }
 */
router.post("/page-subdomain", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { vercelProjectId, landingPageId, subdomainPrefix, mainDomain } = req.body;
    if (!vercelProjectId || typeof vercelProjectId !== "string")
      return res.status(400).json({ error: "vercelProjectId is required" });
    if (!landingPageId || typeof landingPageId !== "string")
      return res.status(400).json({ error: "landingPageId is required" });
    if (!subdomainPrefix || typeof subdomainPrefix !== "string")
      return res.status(400).json({ error: "subdomainPrefix is required" });
    if (!mainDomain || typeof mainDomain !== "string")
      return res.status(400).json({ error: "mainDomain is required" });

    // 1. Add the subdomain to Vercel
    const { fullDomain } = await setPageSubdomain(userId, vercelProjectId, subdomainPrefix, mainDomain);

    // 2. Fetch other pages that already have a subdomainPrefix for domain map rebuild
    const pagesResult = await dynamodb
      .query({
        TableName: LANDING_PAGES_TABLE,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :uid",
        FilterExpression: "vercelProjectId = :pid AND attribute_exists(subdomainPrefix)",
        ExpressionAttributeValues: { ":uid": userId, ":pid": vercelProjectId },
      })
      .promise();
    const existingPages = (pagesResult.Items || []) as Array<{
      id: string;
      slug?: string;
      subdomainPrefix?: string;
    }>;

    // 3. Fetch current page for slug + githubRepoUrl
    const pageResult = await dynamodb
      .get({ TableName: LANDING_PAGES_TABLE, Key: { id: landingPageId } })
      .promise();
    const currentPage = pageResult.Item as any;
    if (!currentPage || currentPage.userId !== userId) {
      return res.status(404).json({ error: "Landing page not found" });
    }

    // 4. Build the complete domain map (other pages + current page with new prefix)
    const domainMap: Record<string, string> = {};
    for (const p of existingPages) {
      if (p.id === landingPageId) continue;
      if (p.subdomainPrefix) {
        domainMap[`${p.subdomainPrefix}.${mainDomain}`] = p.slug ? `/${p.slug}` : "/";
      }
    }
    domainMap[`${subdomainPrefix}.${mainDomain}`] = currentPage.slug
      ? `/${currentPage.slug}`
      : "/";

    // 5. Update GitHub repo middleware
    if (currentPage.githubRepoUrl) {
      const repoMatch = currentPage.githubRepoUrl.match(
        /github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\s|$)/
      );
      if (repoMatch) {
        await updateSubdomainMiddleware(repoMatch[1], domainMap);
      }
    }

    // 6. Persist subdomainPrefix and customDomainUrl to the landing page record
    const customDomainUrl = currentPage.slug
      ? `https://${fullDomain}/${currentPage.slug}`
      : `https://${fullDomain}`;

    await dynamodb
      .update({
        TableName: LANDING_PAGES_TABLE,
        Key: { id: landingPageId },
        ConditionExpression: "userId = :uid",
        UpdateExpression:
          "SET subdomainPrefix = :prefix, customDomainUrl = :url, updatedAt = :now",
        ExpressionAttributeValues: {
          ":prefix": subdomainPrefix,
          ":url": customDomainUrl,
          ":uid": userId,
          ":now": new Date().toISOString(),
        },
      })
      .promise();

    res.status(201).json({ fullDomain, customDomainUrl });
  } catch (error: any) {
    console.error("[DOMAINS] Error setting page subdomain:", error);
    const status = error.message?.includes("Invalid") ? 400 : 500;
    res.status(status).json({ error: error.message || "Failed to set page subdomain" });
  }
});

/**
 * DELETE /api/domains/page-subdomain/:landingPageId
 * Remove the per-page subdomain prefix.
 * Body: { mainDomain }
 */
router.delete("/page-subdomain/:landingPageId", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { landingPageId } = req.params;
    const { mainDomain } = req.body;
    if (!mainDomain || typeof mainDomain !== "string") {
      return res.status(400).json({ error: "mainDomain is required" });
    }

    // Fetch the landing page
    const pageResult = await dynamodb
      .get({ TableName: LANDING_PAGES_TABLE, Key: { id: landingPageId } })
      .promise();
    const page = pageResult.Item as any;
    if (!page || page.userId !== userId) {
      return res.status(404).json({ error: "Landing page not found" });
    }
    if (!page.subdomainPrefix) {
      return res.status(400).json({ error: "No subdomain prefix set for this page" });
    }

    const fullDomain = `${page.subdomainPrefix}.${mainDomain}`;

    // Remove from Vercel
    await removePageSubdomainFromVercel(page.vercelProjectId, fullDomain);

    // Fetch remaining pages for domain map rebuild
    const pagesResult = await dynamodb
      .query({
        TableName: LANDING_PAGES_TABLE,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :uid",
        FilterExpression: "vercelProjectId = :pid AND attribute_exists(subdomainPrefix)",
        ExpressionAttributeValues: { ":uid": userId, ":pid": page.vercelProjectId },
      })
      .promise();
    const remainingPages = ((pagesResult.Items || []) as any[]).filter(
      (p: any) => p.id !== landingPageId
    );

    const domainMap: Record<string, string> = {};
    for (const p of remainingPages) {
      domainMap[`${p.subdomainPrefix}.${mainDomain}`] = p.slug ? `/${p.slug}` : "/";
    }

    // Update GitHub middleware
    if (page.githubRepoUrl) {
      const repoMatch = page.githubRepoUrl.match(
        /github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\s|$)/
      );
      if (repoMatch) {
        await updateSubdomainMiddleware(repoMatch[1], domainMap);
      }
    }

    // Clear subdomainPrefix from the landing page record
    await dynamodb
      .update({
        TableName: LANDING_PAGES_TABLE,
        Key: { id: landingPageId },
        UpdateExpression: "REMOVE subdomainPrefix, customDomainUrl SET updatedAt = :now",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
      .promise();

    res.json({ message: "Subdomain removed" });
  } catch (error: any) {
    console.error("[DOMAINS] Error removing page subdomain:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to remove page subdomain" });
  }
});

export default router;
