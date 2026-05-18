import express from "express";
import { htmlTemplateService, HtmlTemplate } from "../services/htmlTemplateService";
import { userDb, orgDb } from "../services/db";
import { canViewItem, canEditItem, listOrgVisibleItems } from "../services/orgShareService";
import path from "path";
import fs from "fs";
import { extractVariables } from "../utils/templateParser";

const router = express.Router();
const MAX_HTML_BYTES = 512 * 1024; // 512KB

/**
 * Unified HTML Templates Routes
 * Mount point: /api/html-templates
 * Requires authenticateToken applied at mount point (see app.ts).
 * Uses the AW-HtmlTemplates DynamoDB table via htmlTemplateService.
 */

// Helper to resolve caller + owner org info for authorization checks
async function resolveOrgContext(
  callerId: string,
  ownerUserId: string,
): Promise<{ org: Awaited<ReturnType<typeof orgDb.getOrgById>>; ownerOrgId: string | undefined }> {
  const caller = await userDb.getUserById(callerId);
  const callerOrgId = caller?.orgId;
  let ownerOrgId: string | undefined;
  let org = null;
  if (ownerUserId === callerId) {
    ownerOrgId = callerOrgId;
    if (callerOrgId) org = await orgDb.getOrgById(callerOrgId);
  } else {
    const owner = await userDb.getUserById(ownerUserId);
    ownerOrgId = owner?.orgId;
    if (callerOrgId && ownerOrgId === callerOrgId) {
      org = await orgDb.getOrgById(callerOrgId);
    }
  }
  return { org, ownerOrgId };
}

// GET / — list user's templates + public + org-shared
// Supports: ?type=email|landing_page, ?scope=public
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const typeFilter = req.query.type as string | undefined;
    const scopePublicOnly = req.query.scope === "public";

    let items: HtmlTemplate[];
    let truncated = false;

    if (scopePublicOnly) {
      items = (await htmlTemplateService.getPublicTemplates()).map((t) => ({
        ...t,
        isPublic: "true" as const,
      }));
    } else {
      const user = await userDb.getUserById(userId);
      const orgId = user?.orgId;
      const org = orgId ? await orgDb.getOrgById(orgId) : null;
      const enabled = org?.shareSettings?.htmlTemplates?.enabled === true;

      const [own, publicTpls, fanout] = await Promise.all([
        htmlTemplateService.getTemplatesByOwner(userId),
        htmlTemplateService.getPublicTemplates(),
        orgId
          ? listOrgVisibleItems<HtmlTemplate>({
              callerUserId: userId,
              orgId,
              featureEnabled: enabled,
              getOwnerItems: async () => [],
              getMemberIds: async () =>
                (await orgDb.getOrgMembers(orgId)).map((m: any) => m.userId),
              getItemsForOwner: (uid: string) =>
                htmlTemplateService.getTemplatesByOwner(uid),
              getId: (t: HtmlTemplate) => t.templateId,
            })
          : Promise.resolve({ items: [] as HtmlTemplate[], truncated: false }),
      ]);

      truncated = fanout.truncated;

      const seen = new Set<string>();
      items = [...own, ...fanout.items, ...publicTpls].filter((t) => {
        if (seen.has(t.templateId)) return false;
        seen.add(t.templateId);
        return true;
      });
    }

    // Type filtering (matches array-typed 'type' field)
    const result = typeFilter
      ? items.filter(
          (t) => Array.isArray(t.type) && t.type.includes(typeFilter as any),
        )
      : items;

    res.json({ items: result, truncated });
  } catch (e) {
    console.error("[HTML TEMPLATES] Error listing templates:", e);
    res.status(500).json({ error: "Failed to get templates" });
  }
});

// POST / — create a new template
router.post("/", async (req, res) => {
  try {
    const { userId, isAdmin } = (req as any).user;
    const {
      template_name,
      name,
      type,
      html_content,
      html,
      subject,
      variables,
      arrayVariables,
      isPublic,
    } = req.body;

    // Support both old field names (template_name/html_content) and new (name/html)
    const resolvedName = template_name || name;
    const resolvedHtml = html_content || html;

    if (!resolvedName || !type || !resolvedHtml) {
      return res
        .status(400)
        .json({ error: "template_name (or name), type, and html_content (or html) are required" });
    }
    if (!Array.isArray(type) || type.length === 0) {
      return res.status(400).json({ error: "type must be a non-empty array" });
    }
    if (isPublic && !isAdmin) {
      return res
        .status(403)
        .json({ error: "Only admins can manage public templates" });
    }
    if (Buffer.byteLength(resolvedHtml, "utf-8") > MAX_HTML_BYTES) {
      return res.status(413).json({ error: "html_content exceeds 512KB limit" });
    }

    // Auto-extract variables if not supplied
    let finalVariables = variables;
    let finalArrayVariables = arrayVariables;
    if (!finalVariables || !finalArrayVariables) {
      const extracted = extractVariables(resolvedHtml, subject);
      finalVariables = finalVariables ?? extracted.variables;
      finalArrayVariables = finalArrayVariables ?? extracted.arrayVariables;
    }

    const tpl = await htmlTemplateService.createTemplate({
      userId,
      type,
      name: resolvedName,
      subject,
      html: resolvedHtml,
      ...(isPublic ? { isPublic: "true" as const } : {}),
    });

    res.status(201).json({ success: true, message: "Template saved successfully", template: tpl });
  } catch (e) {
    console.error("[HTML TEMPLATES] Error creating template:", e);
    res.status(500).json({ error: "Failed to save template" });
  }
});

// GET /preview/:templateId — render HTML preview (legacy path support)
// Must be defined BEFORE /:id to avoid route conflict
router.get("/preview/:templateId", async (req, res) => {
  try {
    const { templateId } = req.params;
    const { userId } = (req as any).user;

    // 1. Try the AW-HtmlTemplates table (own + public)
    const [userTpls, publicTpls] = await Promise.all([
      htmlTemplateService.getTemplatesByOwner(userId),
      htmlTemplateService.getPublicTemplates(),
    ]);
    const found = [...userTpls, ...publicTpls].find(
      (t) => t.templateId === templateId,
    );
    if (found) {
      res.setHeader("Content-Type", "text/html");
      return res.send(found.html);
    }

    // 2. Legacy filesystem fallback
    if (templateId === "default-v2" || templateId === "landing-page-v2") {
      try {
        const filePath = path.join(
          __dirname,
          "..",
          "templates",
          "landing-page-v2.html",
        );
        if (fs.existsSync(filePath)) {
          const html = await fs.promises.readFile(filePath, "utf-8");
          res.setHeader("Content-Type", "text/html");
          return res.send(html);
        }
      } catch (err) {
        console.error("[HTML TEMPLATES] FS fallback failed:", err);
      }
    }

    res.status(404).json({ error: "Template not found" });
  } catch (e) {
    console.error("[HTML TEMPLATES] Preview error:", e);
    res.status(500).json({ error: "Failed to load preview" });
  }
});

// GET /:id — view a single template (org-share-aware)
router.get("/:id", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const tpl = await htmlTemplateService.getTemplate(req.params.id);
    if (!tpl) return res.status(404).json({ error: "Template not found" });

    // Public templates: visible to all authenticated users
    if (tpl.isPublic === "true") return res.json(tpl);

    const caller = await userDb.getUserById(userId);
    const { org, ownerOrgId } = await resolveOrgContext(userId, tpl.userId);

    const allowed = canViewItem(
      { userId: tpl.userId },
      { userId, orgId: caller?.orgId, orgRole: caller?.orgRole },
      org,
      ownerOrgId,
      "htmlTemplates",
    );
    if (!allowed) return res.status(403).json({ error: "Not authorized" });
    res.json(tpl);
  } catch (e) {
    console.error("[HTML TEMPLATES] Error fetching template:", e);
    res.status(500).json({ error: "Failed to fetch template" });
  }
});

// PUT /:id — update a template (org-share-aware)
router.put("/:id", async (req, res) => {
  try {
    const { userId, isAdmin } = (req as any).user;
    const tpl = await htmlTemplateService.getTemplate(req.params.id);
    if (!tpl) return res.status(404).json({ error: "Template not found" });
    if (tpl.isPublic === "true" && !isAdmin) {
      return res
        .status(403)
        .json({ error: "Public templates are admin-managed" });
    }

    const caller = await userDb.getUserById(userId);
    const { org, ownerOrgId } = await resolveOrgContext(userId, tpl.userId);

    const allowed = canEditItem(
      { userId: tpl.userId },
      { userId, orgId: caller?.orgId, orgRole: caller?.orgRole },
      org,
      ownerOrgId,
      "htmlTemplates",
    );
    if (!allowed) return res.status(403).json({ error: "Not authorized" });

    const { template_name, name, type, html_content, html, subject } = req.body;
    const resolvedName = template_name ?? name;
    const resolvedHtml = html_content ?? html;

    const updated = await htmlTemplateService.updateTemplate(req.params.id, {
      ...(type !== undefined && { type }),
      ...(resolvedName !== undefined && { name: resolvedName }),
      ...(subject !== undefined && { subject }),
      ...(resolvedHtml !== undefined && { html: resolvedHtml }),
    });
    res.json({ success: true, message: "Template saved successfully", template: updated });
  } catch (e) {
    console.error("[HTML TEMPLATES] Error updating template:", e);
    res.status(500).json({ error: "Failed to save template" });
  }
});

// DELETE /:templateId — delete (owner or org admin only; public templates require isAdmin)
router.delete("/:templateId", async (req, res) => {
  try {
    const { userId, isAdmin } = (req as any).user;
    const { templateId } = req.params;
    const isPublicParam = req.query.isPublic === "true";

    const tpl = await htmlTemplateService.getTemplate(templateId);
    if (!tpl) return res.status(404).json({ error: "Template not found" });

    if (tpl.isPublic === "true") {
      if (!isAdmin && !isPublicParam) {
        return res
          .status(403)
          .json({ error: "Only admins can delete public templates" });
      }
      if (!isAdmin) {
        return res
          .status(403)
          .json({ error: "Only admins can delete public templates" });
      }
    }

    const caller = await userDb.getUserById(userId);
    let allowed = tpl.userId === userId || isAdmin;
    if (!allowed && caller?.orgId && caller.orgRole === "owner") {
      const owner = await userDb.getUserById(tpl.userId);
      if (owner?.orgId === caller.orgId) allowed = true;
    }
    if (!allowed) return res.status(403).json({ error: "Not authorized" });

    await htmlTemplateService.deleteTemplate(templateId);
    res.json({ success: true, message: "Template deleted" });
  } catch (e) {
    console.error("[HTML TEMPLATES] Error deleting template:", e);
    res.status(500).json({ error: "Failed to delete template" });
  }
});

export default router;
