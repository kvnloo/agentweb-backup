/**
 * HTML Templates Routes (settings-based storage)
 *
 * All templates are stored in AW-Settings as JSON arrays:
 *   templates_<userId>  — per-user private templates
 *   templates_public    — admin-published public templates
 *
 * Mount point: /api/html-templates (with authenticateToken applied at mount)
 */
import express from "express";
import path from "path";
import fs from "fs";
import { htmlTemplateService } from "../services/htmlTemplateService";
import { userDb, orgDb } from "../services/db";
import {
  canViewItem,
  canEditItem,
  canManageOrgFeature,
  isFeatureEffectivelyEnabled,
  listOrgVisibleItems,
} from "../services/orgShareService";
import { extractVariables } from "../utils/templateParser";

const router = express.Router();

const MAX_HTML_BYTES = 512 * 1024; // 512 KB

// ── GET / — list own + public + (when enabled) org-fanned-out templates ────
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;
    const org = orgId ? await orgDb.getOrgById(orgId) : null;
    const enabled = isFeatureEffectivelyEnabled(
      { userId, orgId, orgRole: user?.orgRole as "owner" | "member" | undefined },
      org,
      "htmlTemplates",
    );

    const [ownTemplatesRaw, publicTemplatesRaw, fanout] = await Promise.all([
      htmlTemplateService.getTemplatesByOwner(userId),
      htmlTemplateService.getPublicTemplates(),
      orgId
        ? listOrgVisibleItems({
            callerUserId: userId,
            orgId,
            featureEnabled: enabled,
            getOwnerItems: async () => [],
            getMemberIds: async () =>
              (await orgDb.getOrgMembers(orgId)).map((m: any) => m.userId),
            // Stamp each fanout item with the owner's userId so the frontend
            // can render "Shared by ..." and target PATCH/DELETE correctly.
            getItemsForOwner: async (uid: string) =>
              (await htmlTemplateService.getTemplatesByOwner(uid)).map((t) => ({
                ...t,
                userId: uid,
              })),
            getId: (t: any) => t.template_id,
          })
        : Promise.resolve({ items: [], truncated: false }),
    ]);

    // Stamp own templates with the caller's userId, public ones with the sentinel.
    const ownTemplates = ownTemplatesRaw.map((t) => ({ ...t, userId }));
    const publicTemplates = publicTemplatesRaw.map((t) => ({
      ...t,
      userId: "__public__",
      isPublic: true,
    }));

    const seen = new Set<string>();
    const all = [
      ...ownTemplates,
      ...fanout.items,
      ...publicTemplates,
    ].filter((t) => {
      if (seen.has(t.template_id)) return false;
      seen.add(t.template_id);
      return true;
    });

    const typeFilter = req.query.type as string | undefined;
    const filtered = typeFilter
      ? all.filter((t: any) => Array.isArray(t.type) && t.type.includes(typeFilter))
      : all;

    res.json({ items: filtered, truncated: fanout.truncated });
  } catch (error) {
    console.error("[HTML TEMPLATES] Error listing templates:", error);
    res.status(500).json({ error: "Failed to get templates" });
  }
});

// ── GET /preview/:templateId — legacy preview path ────────────────────────
router.get("/preview/:templateId", async (req, res) => {
  try {
    const { templateId } = req.params;
    const { userId } = (req as any).user;

    const [userTemplates, publicTemplates] = await Promise.all([
      htmlTemplateService.getTemplatesByOwner(userId),
      htmlTemplateService.getPublicTemplates(),
    ]);

    const found = [...userTemplates, ...publicTemplates].find(
      (t) => t.template_id === templateId,
    );
    if (found) {
      res.setHeader("Content-Type", "text/html");
      return res.send(found.html_content);
    }

    // Filesystem fallback for built-in template IDs
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
  } catch (error) {
    console.error("[HTML TEMPLATES] Preview error:", error);
    res.status(500).json({ error: "Failed to load preview" });
  }
});

// ── GET /:templateId — view a single template ─────────────────────────────
router.get("/:templateId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { templateId } = req.params;
    const ownerUserId = (req.query.ownerUserId as string) || userId;

    if (ownerUserId === userId) {
      const tpl =
        (await htmlTemplateService.getTemplate(templateId, userId)) ??
        (await htmlTemplateService.getPublicTemplate(templateId));
      if (!tpl) return res.status(404).json({ error: "Template not found" });
      return res.json(tpl);
    }

    // Caller is requesting someone else's template — check org permission
    const [callerUser, ownerUser] = await Promise.all([
      userDb.getUserById(userId),
      userDb.getUserById(ownerUserId),
    ]);
    const callerOrgId = callerUser?.orgId;
    const org = callerOrgId ? await orgDb.getOrgById(callerOrgId) : null;

    const tpl = await htmlTemplateService.getTemplate(templateId, ownerUserId);
    if (!tpl) return res.status(404).json({ error: "Template not found" });

    const itemLike = { userId: ownerUserId };
    const userLike = {
      userId,
      orgId: callerOrgId,
      orgRole: callerUser?.orgRole as "owner" | "member" | undefined,
    };
    if (!canViewItem(itemLike, userLike, org, ownerUser?.orgId, "htmlTemplates")) {
      return res.status(403).json({ error: "Not authorized" });
    }

    res.json(tpl);
  } catch (error) {
    console.error("[HTML TEMPLATES] Error fetching template:", error);
    res.status(500).json({ error: "Failed to get template" });
  }
});

// ── POST / — create a new template ────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { userId, email } = (req as any).user;

    // Org-level create gating: when caller belongs to an org, only the org
    // owner or a listed editor (when htmlTemplates sharing is enabled) may
    // create templates. Solo users are unaffected.
    const caller = await userDb.getUserById(userId);
    if (caller?.orgId) {
      const org = await orgDb.getOrgById(caller.orgId);
      const allowed = canManageOrgFeature(
        { userId, orgId: caller.orgId, orgRole: caller.orgRole as "owner" | "member" | undefined },
        org,
        "htmlTemplates",
      );
      if (!allowed) {
        return res.status(403).json({ error: "Templates are managed by your org admin" });
      }
    }

    // Accept both legacy field names (template_name/html_content) and short names
    const template_name = req.body.template_name || req.body.name;
    const html_content = req.body.html_content || req.body.html;
    const { type, subject } = req.body;
    let { variables, arrayVariables } = req.body;

    if (!template_name || !html_content) {
      return res
        .status(400)
        .json({ error: "template_name and html_content are required" });
    }
    if (Buffer.byteLength(html_content, "utf-8") > MAX_HTML_BYTES) {
      return res
        .status(413)
        .json({ error: "html_content exceeds 512KB limit" });
    }

    // Normalize type
    const normalizedType: ("email" | "landing_page")[] = Array.isArray(type)
      ? type
      : type
        ? [type as "email" | "landing_page"]
        : ["email"];

    // Auto-extract variables if not supplied
    if (!variables || !arrayVariables) {
      const extracted = extractVariables(html_content, subject);
      variables = variables ?? extracted.variables;
      arrayVariables = arrayVariables ?? extracted.arrayVariables;
    }

    const tpl = await htmlTemplateService.createTemplate(
      userId,
      {
        template_name,
        type: normalizedType,
        html_content,
        subject,
        variables,
        arrayVariables,
      },
      email,
    );

    res
      .status(201)
      .json({ success: true, message: "Template created successfully", template: tpl });
  } catch (error) {
    console.error("[HTML TEMPLATES] Error creating template:", error);
    res.status(500).json({ error: "Failed to create template" });
  }
});

// ── PUT /:templateId — update a template ──────────────────────────────────
router.put("/:templateId", async (req, res) => {
  try {
    const { userId, email } = (req as any).user;
    const { templateId } = req.params;
    const ownerUserId = (req.query.ownerUserId as string) || userId;

    // Resolve permission when editing someone else's template
    if (ownerUserId !== userId) {
      const [callerUser, ownerUser] = await Promise.all([
        userDb.getUserById(userId),
        userDb.getUserById(ownerUserId),
      ]);
      const callerOrgId = callerUser?.orgId;
      const org = callerOrgId ? await orgDb.getOrgById(callerOrgId) : null;

      const tpl = await htmlTemplateService.getTemplate(templateId, ownerUserId);
      if (!tpl) return res.status(404).json({ error: "Template not found" });

      const itemLike = { userId: ownerUserId };
      const userLike = {
        userId,
        orgId: callerOrgId,
        orgRole: callerUser?.orgRole as "owner" | "member" | undefined,
      };
      if (!canEditItem(itemLike, userLike, org, ownerUser?.orgId, "htmlTemplates")) {
        return res.status(403).json({ error: "Not authorized" });
      }
    }

    const {
      template_name,
      type,
      subject,
      html_content,
      variables,
      arrayVariables,
    } = req.body;

    const fields: any = {};
    if (template_name !== undefined) fields.template_name = template_name;
    if (html_content !== undefined) {
      if (Buffer.byteLength(html_content, "utf-8") > MAX_HTML_BYTES) {
        return res
          .status(413)
          .json({ error: "html_content exceeds 512KB limit" });
      }
      fields.html_content = html_content;
    }
    if (type !== undefined) {
      fields.type = Array.isArray(type) ? type : [type];
    }
    if (subject !== undefined) fields.subject = subject;
    if (variables !== undefined) fields.variables = variables;
    if (arrayVariables !== undefined) fields.arrayVariables = arrayVariables;

    const updated = await htmlTemplateService.updateTemplate(
      templateId,
      ownerUserId,
      fields,
      email,
    );
    if (!updated) return res.status(404).json({ error: "Template not found" });

    res.json({ success: true, message: "Template updated successfully", template: updated });
  } catch (error) {
    console.error("[HTML TEMPLATES] Error updating template:", error);
    res.status(500).json({ error: "Failed to update template" });
  }
});

// ── DELETE /:templateId — delete a template ───────────────────────────────
router.delete("/:templateId", async (req, res) => {
  try {
    const { userId, email } = (req as any).user;
    const { templateId } = req.params;
    const ownerUserId = (req.query.ownerUserId as string) || userId;

    if (ownerUserId !== userId) {
      // Only owner or org owner (admin override) may delete — editors cannot
      const [callerUser, ownerUser] = await Promise.all([
        userDb.getUserById(userId),
        userDb.getUserById(ownerUserId),
      ]);
      const callerOrgId = callerUser?.orgId;
      let allowed = false;
      if (
        callerUser?.orgRole === "owner" &&
        callerOrgId &&
        ownerUser?.orgId === callerOrgId
      ) {
        allowed = true;
      }
      if (!allowed) {
        return res.status(403).json({ error: "Not authorized" });
      }
    }

    const deleted = await htmlTemplateService.deleteTemplate(
      templateId,
      ownerUserId,
      email,
    );
    if (!deleted) return res.status(404).json({ error: "Template not found" });

    res.json({ success: true, message: "Template deleted" });
  } catch (error) {
    console.error("[HTML TEMPLATES] Error deleting template:", error);
    res.status(500).json({ error: "Failed to delete template" });
  }
});

export default router;
