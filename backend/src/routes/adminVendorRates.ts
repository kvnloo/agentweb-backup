/**
 * Admin editor for the PROVISIONAL vendor rates (ENG-2271): owners change the
 * Twilio spend rates at runtime, no deploy. Defaults stay in vendorRateCard.ts.
 *
 *   GET /api/admin/vendor-rates
 *   PUT /api/admin/vendor-rates   body { provider, key, usdPerUnit: number | null }
 *
 * Storage is the AW-Settings item `vendor_rate_overrides` (no new table); null
 * removes one override. Auth is per-route like adminV0Credits so mounting this
 * router changes nothing for other /api/admin paths.
 */

import express, { Response } from "express";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { AuthRequest } from "../types/express";
import { settingsService } from "../services/settingsService";
import {
  EDITABLE_VENDOR_RATE_PROVIDERS,
  MAX_OVERRIDE_USD_PER_UNIT,
  VENDOR_RATE_OVERRIDES_SETTING,
  VendorRateOverrideState,
  VendorRateOverrides,
  VendorRateProvider,
  applyVendorRateOverridesLocally,
  describeEditableRates,
  isEditableVendorRate,
  isValidOverrideRate,
  parseVendorRateOverrides,
  rateCardVersionFor,
} from "../utils/vendorRateCard";

const router = express.Router();

const BODY_KEYS = ["provider", "key", "usdPerUnit"];
const MAX_WRITE_ATTEMPTS = 3;

class ValidationError extends Error {}

function toResponse(state: VendorRateOverrideState) {
  return {
    version: rateCardVersionFor(state),
    editableProviders: [...EDITABLE_VENDOR_RATE_PROVIDERS],
    rates: describeEditableRates(state),
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
}

function parseBody(body: unknown): { provider: VendorRateProvider; key: string; usdPerUnit: number | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Body must be a JSON object");
  const extra = Object.keys(body).filter((k) => !BODY_KEYS.includes(k));
  if (extra.length > 0) throw new ValidationError(`Unexpected field(s): ${extra.join(", ")}`);
  const { provider, key, usdPerUnit } = body as Record<string, unknown>;
  if (typeof provider !== "string" || typeof key !== "string") {
    throw new ValidationError("provider and key must be strings");
  }
  if (!(EDITABLE_VENDOR_RATE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ValidationError(`Provider "${provider}" is not editable; editable: ${EDITABLE_VENDOR_RATE_PROVIDERS.join(", ")}`);
  }
  if (!isEditableVendorRate(provider, key)) throw new ValidationError(`Unknown rate key "${key}" for ${provider}`);
  if (usdPerUnit !== null && !isValidOverrideRate(usdPerUnit)) {
    throw new ValidationError(`usdPerUnit must be null or a finite number greater than 0 and at most ${MAX_OVERRIDE_USD_PER_UNIT}`);
  }
  return { provider: provider as VendorRateProvider, key, usdPerUnit };
}

router.get("/vendor-rates", authenticateToken, isAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const row = await settingsService.getSetting(VENDOR_RATE_OVERRIDES_SETTING);
    return res.json(toResponse(parseVendorRateOverrides(row?.settingValue)));
  } catch (error) {
    console.error("[adminVendorRates] read failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ error: "Failed to read vendor rates" });
  }
});

router.put("/vendor-rates", authenticateToken, isAdmin, async (req: AuthRequest, res: Response) => {
  let change: ReturnType<typeof parseBody>;
  try {
    change = parseBody(req.body);
  } catch (error) {
    return res.status(400).json({ error: error instanceof ValidationError ? error.message : "Invalid request" });
  }
  const adminId = req.user?.userId;
  if (!adminId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Read-modify-write guarded by the exact raw value read (optimistic concurrency), so two
    // admins editing different keys cannot silently drop each other's change.
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const row = await settingsService.getSetting(VENDOR_RATE_OVERRIDES_SETTING);
      const before = parseVendorRateOverrides(row?.settingValue);
      const overrides: VendorRateOverrides = {};
      for (const [p, entries] of Object.entries(before.overrides)) {
        overrides[p as VendorRateProvider] = { ...entries };
      }
      const oldValue = overrides[change.provider]?.[change.key] ?? null;
      if (change.usdPerUnit === null) {
        const block = overrides[change.provider];
        if (block) {
          delete block[change.key];
          if (Object.keys(block).length === 0) delete overrides[change.provider];
        }
      } else {
        (overrides[change.provider] ??= {})[change.key] = change.usdPerUnit;
      }

      const updatedAt = new Date().toISOString();
      const value = JSON.stringify({ overrides, updatedAt, updatedBy: adminId });
      const description = "Admin overrides of provisional vendor spend rates (ENG-2271)";
      try {
        if (row) {
          await settingsService.setSettingIfValueMatches(
            VENDOR_RATE_OVERRIDES_SETTING, value, row.settingValue, description, adminId,
          );
        } else if (!(await settingsService.setSettingIfAbsent(VENDOR_RATE_OVERRIDES_SETTING, value, description, adminId))) {
          continue;
        }
      } catch (error) {
        if ((error as { code?: string })?.code === "ConditionalCheckFailedException") continue;
        throw error;
      }

      console.info(
        `[adminVendorRates] admin=${adminId} ${change.provider}:${change.key} ${oldValue} -> ${change.usdPerUnit}`,
      );
      // Parse what was written so this instance applies exactly the persisted state at once;
      // other instances pick it up within the cache TTL.
      const written = parseVendorRateOverrides(value);
      applyVendorRateOverridesLocally(written);
      return res.json(toResponse(written));
    }
    return res.status(409).json({ error: "Vendor rates changed concurrently; reload and retry" });
  } catch (error) {
    console.error("[adminVendorRates] write failed:", error instanceof Error ? error.message : error);
    return res.status(500).json({ error: "Failed to save vendor rate" });
  }
});

export default router;
