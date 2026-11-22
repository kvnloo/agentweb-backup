import { Router, type RequestHandler } from "express";
import { authenticateToken, type AuthenticatedRequest } from "../middleware/auth";
import { userDb } from "../services/db";
import {
  getCustomerUtmDefault,
  setCustomerUtmDefault,
  getLanderUtmOverride,
  setLanderUtmOverride,
} from "../services/landerUtmStore";
import {
  getLandingPagesByOwner,
  getLandingPagesByOrg,
  getLandingPageById,
} from "../services/v0Service";
import {
  LANDER_PROVENANCE_KEY,
  resolveLanderParams,
  validateUtmConfig,
} from "../utils/landerUtm";

const router = Router();
router.use(authenticateToken);

// Both writes accept an explicit null to clear; missing/empty is never a clear.
// Validate separately from persistence so storage failures remain server errors.
function validateWrite(field: "default" | "override"): RequestHandler {
  return (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
          !Object.prototype.hasOwnProperty.call(req.body, field)) {
        throw new Error(`${field} is required`);
      }
      const value = req.body[field];
      const config = value === null ? null : validateUtmConfig(value, field);
      if (config !== null && Object.keys(config).length === 0) {
        throw new Error(`${field} is empty — pass null to clear`);
      }
      req.body = { [field]: config };
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
    next();
  };
}

router.get("/default", async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user.userId;
    res.json({ default: await getCustomerUtmDefault(userId) });
  } catch (error) {
    console.error("[LANDER UTM] Failed to read default:", error);
    res.status(500).json({ error: "Failed to read UTM default" });
  }
});

router.put("/default", validateWrite("default"), async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user.userId;
    // Default edits never enumerate, redeploy, or write any lander.
    res.json({ default: await setCustomerUtmDefault(userId, req.body.default) });
  } catch (error) {
    console.error("[LANDER UTM] Failed to save default:", error);
    res.status(500).json({ error: "Failed to save UTM default" });
  }
});

router.get("/landers", async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user.userId;
    const [user, customerDefault, ownPages] = await Promise.all([
      userDb.getUserById(userId),
      getCustomerUtmDefault(userId),
      getLandingPagesByOwner(userId),
    ]);
    // Match getLanderUtmOverride's owner-or-same-org scope.
    const orgPages = user?.orgId ? await getLandingPagesByOrg(user.orgId, userId) : [];
    const seen = new Set<string>();
    const pages = [...ownPages, ...orgPages].filter((page) => {
      if (seen.has(page.id)) return false;
      seen.add(page.id);
      return true;
    });
    const landers = await Promise.all(pages.map(async (page) => {
      const override = await getLanderUtmOverride(page.id, userId);
      const { params } = resolveLanderParams({
        customerDefault: customerDefault ?? undefined,
        override: override ?? undefined,
      });
      // The portal edits UTM config, not the resolver-owned provenance marker.
      const { [LANDER_PROVENANCE_KEY]: _provenance, ...effective } = params;
      return {
        pageId: page.id,
        name: page.name,
        override,
        effective: Object.keys(effective).length ? effective : null,
        state: override !== null ? "overridden" : customerDefault !== null ? "inherited" : "not_set",
      };
    }));
    res.json({ landers });
  } catch (error) {
    console.error("[LANDER UTM] Failed to list landers:", error);
    res.status(500).json({ error: "Failed to fetch landing pages" });
  }
});

router.put("/landers/:pageId/override", validateWrite("override"), async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user.userId;
    const page = await getLandingPageById(req.params.pageId);
    if (!page || typeof page.userId !== "string" || !page.userId) {
      return res.status(404).json({ error: "Landing page not found" });
    }
    if (page.userId !== userId) {
      const [caller, owner] = await Promise.all([
        userDb.getUserById(userId),
        userDb.getUserById(page.userId),
      ]);
      if (!caller?.orgId || owner?.orgId !== caller.orgId) {
        return res.status(404).json({ error: "Landing page not found" });
      }
    }
    // The store setter is unscoped; authorize before passing it any page ID.
    res.json({ override: await setLanderUtmOverride(page.id, req.body.override) });
  } catch (error) {
    console.error("[LANDER UTM] Failed to save override:", error);
    res.status(500).json({ error: "Failed to save UTM override" });
  }
});

export default router;
