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
import { getOutreachInvitePrompt } from "../services/outreachInvitePromptService";
import {
  generateInviteDrafts,
  DEFAULT_INVITE_CHAR_LIMIT,
} from "../services/outreachInviteDraftService";

const router = express.Router();

/**
 * GET /api/onboarding/outreach/invite-template
 *
 * Returns the admin-editable variant pool the onboarding "review your drafts"
 * step uses for its INSTANT pre-fill (AC #1) — deterministic interpolation, no
 * LLM, so textareas are never empty while the model is still thinking. The
 * LLM upgrade then arrives via POST /outreach/draft-invites below.
 *
 * The system prompt is deliberately NOT returned here: it is only ever
 * composed server-side, so there is no reason to ship it to every onboarding
 * user. Admins edit it at `/api/admin/prompt-templates/outreach/invite`.
 *
 * Never fails the flow: the service degrades to its seed constants if
 * DynamoDB is unreachable, and the FE has its own built-in fallback pool.
 *
 * Response (200)
 *   { withCompanyVariants: string[], withoutCompanyVariants: string[],
 *     version: string }
 */
router.get("/outreach/invite-template", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user?.userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const row = await getOutreachInvitePrompt();
    return res.status(200).json({
      withCompanyVariants: row.withCompanyVariants,
      withoutCompanyVariants: row.withoutCompanyVariants,
      version: row.version,
    });
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error("[onboarding/outreach/invite-template] error:", err);
    return res
      .status(500)
      .json({ message: err?.message ?? "Internal error" });
  }
});

/** One user's batch cannot fan out unbounded LLM work. */
const MAX_DRAFT_BATCH = 50;

/**
 * Invite-note char budget for the account that will actually send these
 * invites: 300 on a Premium LinkedIn account, 200 on a free one.
 *
 * The real send resolves the account from the eventual lead list
 * (`list.linkedInAccountId`) with `resolveUserOwnedAccountId` only as a
 * fallback (see `routes/crm.ts` send-invite path). At draft time that list
 * doesn't exist yet, so we can only be SURE which account sends when the user
 * owns exactly one. With zero or more than one owned account the sender is
 * ambiguous, so we default to the free limit rather than over-promise a
 * 300-char note that a free sending account would silently trim to 200.
 */
async function resolveInviteCharLimit(userId: string): Promise<number> {
  try {
    const { linkedInOutreachService } = await import(
      "../services/linkedInOutreachService"
    );
    const accountIds =
      await linkedInOutreachService.listUserOwnedUnipileAccountIds(userId);
    // 0 owned → free default; >1 → ambiguous sender, stay safe at free.
    if (accountIds.length !== 1) return DEFAULT_INVITE_CHAR_LIMIT;
    return await linkedInOutreachService.getInviteCharLimitForAccount(
      userId,
      accountIds[0],
    );
  } catch {
    return DEFAULT_INVITE_CHAR_LIMIT;
  }
}

/**
 * POST /api/onboarding/outreach/draft-invites
 *
 * Drafts a LinkedIn invite per prospect using the ADMIN-EDITABLE system prompt
 * (AC #3) plus brand + ICP context (AC #1). This is what makes an admin's
 * prompt edit actually change the messages users see, with no deploy.
 *
 * The frontend has already pre-filled every textarea from the template pool by
 * the time this is called, so this endpoint is an *upgrade*, not a dependency:
 * it returns 200 with `drafts: []` on any failure and the user keeps the
 * instant copy. Rows the user already edited are never overwritten (the
 * frontend owns that rule).
 *
 * Body: { prospects: [{id, name?, company?, title?}], brandName?, icpName?, specs? }
 * Response (200): { drafts: [{prospectId, message}], promptVersion }
 */
router.post("/outreach/draft-invites", authenticateToken, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user?.userId) {
    return res.status(401).json({ message: "User not authenticated" });
  }

  const body = req.body ?? {};
  if (!Array.isArray(body.prospects)) {
    return res.status(400).json({ message: "prospects must be an array" });
  }
  if (body.prospects.some((p: any) => typeof p?.id !== "string" || !p.id)) {
    return res
      .status(400)
      .json({ message: "every prospect requires a string id" });
  }
  if (body.prospects.length === 0) {
    // Nothing to draft — don't spend a model call to find that out. The char
    // limit still matters: the FE renders its counter from it.
    return res.status(200).json({
      drafts: [],
      promptVersion: null,
      charLimit: await resolveInviteCharLimit(authReq.user.userId),
    });
  }

  try {
    const charLimit = await resolveInviteCharLimit(authReq.user.userId);
    const result = await generateInviteDrafts(
      body.prospects.slice(0, MAX_DRAFT_BATCH).map((p: any) => ({
        id: p.id,
        name: typeof p.name === "string" ? p.name : undefined,
        company: typeof p.company === "string" ? p.company : undefined,
        title: typeof p.title === "string" ? p.title : undefined,
      })),
      {
        brandName:
          typeof body.brandName === "string" ? body.brandName : undefined,
        icpName: typeof body.icpName === "string" ? body.icpName : undefined,
        specs: typeof body.specs === "string" ? body.specs : undefined,
        charLimit,
        // Attribute the model spend to this user (per-user cost cap).
        userId: authReq.user.userId,
      },
    );
    return res.status(200).json(result);
  } catch (err: any) {
    // Defense in depth — the service already swallows its own failures.
    // eslint-disable-next-line no-console
    console.error("[onboarding/outreach/draft-invites] error:", err);
    return res.status(200).json({
      drafts: [],
      promptVersion: null,
      charLimit: DEFAULT_INVITE_CHAR_LIMIT,
    });
  }
});

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
