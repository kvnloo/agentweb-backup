/**
 * Outreach Onboarding sub-task 4 — Prospect search reveal endpoint.
 *
 * Stateless preview endpoint. The onboarding flow calls this from the
 * `outreachProspectReveal` screen with `{ icp, specifications }` from
 * sub-tasks 2 + 3 and renders 5–10 real-human prospect cards. It does
 * NOT touch the CRM — sub-task 7 owns the eventual save via the existing
 * `import_leads_from_search` Emma tool.
 *
 * Endpoint
 *   POST /api/onboarding/outreach/preview-prospects
 *
 * Request body
 *   { icp?: string, specifications?: string, title?: string,
 *     company?: string, limit?: number }
 *
 * Response (200)
 *   { items: PreviewProspect[], linkedinConnected: boolean,
 *     cursor?: string }
 *
 * Response shapes for the unhappy paths are documented next to each
 * branch — the FE relies on them so don't re-shuffle without bumping
 * the FE call site too.
 */

import express from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { searchProspectsPreview } from "../services/outreachProspectPreviewService";
import { saveOutreachProspects } from "../services/outreachOnboardingSaveService";

const router = express.Router();

router.post(
  "/outreach/preview-prospects",
  authenticateToken,
  async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
      }

      const body = (req.body ?? {}) as {
        icp?: unknown;
        specifications?: unknown;
        title?: unknown;
        company?: unknown;
        limit?: unknown;
      };

      const result = await searchProspectsPreview(userId, {
        icp: typeof body.icp === "string" ? body.icp : null,
        specifications:
          typeof body.specifications === "string" ? body.specifications : null,
        title: typeof body.title === "string" ? body.title : null,
        company: typeof body.company === "string" ? body.company : null,
        limit:
          typeof body.limit === "number" && Number.isFinite(body.limit)
            ? body.limit
            : undefined,
      });

      if (result.ok) {
        return res.status(200).json({
          items: result.items,
          linkedinConnected: result.linkedinConnected,
          cursor: result.cursor,
        });
      }

      // Error envelope handling — codes documented in the service file.
      switch (result.error) {
        case "no_filters":
          return res.status(400).json({
            message:
              "Provide at least an ICP or specifications to search for prospects.",
            code: "no_filters",
          });
        case "no_linkedin_account":
          // Not a hard failure — the onboarding flow keeps going with an
          // empty list + a skip-LinkedIn affordance. Return 200 so the FE
          // can render the empty state without surfacing a scary error
          // banner. `linkedinConnected: false` is the signal that the
          // platform fallback is also unavailable.
          return res.status(200).json({
            items: [],
            linkedinConnected: false,
            noLinkedInAccount: true,
            message:
              "No LinkedIn account is available. Connect your LinkedIn or skip this step — Emma will still draft messages from the ICP.",
          });
        case "unipile_error":
          return res.status(502).json({
            message: result.message ?? "LinkedIn search failed",
            code: "unipile_error",
          });
        default:
          return res
            .status(500)
            .json({ message: "Unknown error generating prospect preview" });
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[onboarding/outreach/preview-prospects] error:", err);
      return res
        .status(500)
        .json({ message: err?.message ?? "Internal error" });
    }
  },
);

/**
 * POST /api/onboarding/outreach/save
 *
 * Persist the prospect cards the user kept (from preview-prospects) plus the
 * messages Emma drafted for each into a brand-new CRM Lead List owned by the
 * authenticated user. Reuses the same crmDb lead-import path the Emma
 * `import_leads_from_search` tool uses (see outreachOnboardingSaveService).
 *
 * Request body
 *   { icpId: string, icpLabel?: string,
 *     prospects: PreviewProspect[], drafts: Record<string, string> }
 *
 * Response (200)
 *   { leadListId: string }
 *
 * Unhappy paths (the FE relies on these shapes):
 *   400 — empty/absent prospects array
 *   401 — unauthenticated
 *   502 — underlying CRM/lead service errored
 *   500 — unexpected error
 */
router.post("/outreach/save", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const body = (req.body ?? {}) as {
      icpId?: unknown;
      icpLabel?: unknown;
      prospects?: unknown;
      drafts?: unknown;
    };

    const prospects = Array.isArray(body.prospects) ? body.prospects : [];
    // Reject empty prospects before touching the CRM — nothing to save.
    if (prospects.length === 0) {
      return res.status(400).json({
        message: "Provide at least one prospect to save.",
        code: "no_prospects",
      });
    }

    const result = await saveOutreachProspects(userId, {
      icpId: typeof body.icpId === "string" ? body.icpId : "",
      icpLabel: typeof body.icpLabel === "string" ? body.icpLabel : undefined,
      prospects: prospects as any,
      drafts:
        body.drafts && typeof body.drafts === "object"
          ? (body.drafts as Record<string, string>)
          : {},
    });

    if (result.ok) {
      return res.status(200).json({ leadListId: result.leadListId });
    }

    switch (result.error) {
      case "no_prospects":
        return res.status(400).json({
          message: "Provide at least one prospect to save.",
          code: "no_prospects",
        });
      case "crm_error":
        return res.status(502).json({
          message: result.message ?? "Failed to save prospects to CRM",
          code: "crm_error",
        });
      default:
        return res
          .status(500)
          .json({ message: "Unknown error saving outreach prospects" });
    }
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("[onboarding/outreach/save] error:", err);
    return res
      .status(500)
      .json({ message: err?.message ?? "Internal error" });
  }
});

export default router;
