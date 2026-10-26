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
 *
 * No durable audit history by decision: the applied rate is derivable from an event's
 * costMicroUsd / quantity (rates have at most 6 decimals, see isValidOverrideRate), and each
 * change is logged with the admin id and old/new value. The rate guarantees >= 1 micro-dollar
 * per WHOLE unit; fractional quantities can still round to 0, and Twilio recording uses whole
 * billable minutes.
 */

import express, { Response } from "express";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { AuthRequest } from "../types/express";
import { Setting, settingsService } from "../services/settingsService";
import { isConditionalFailure } from "../services/voice/setupWrites";
import {
  EDITABLE_VENDOR_RATE_PROVIDERS,
  isEditableProvider,
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
const DESCRIPTION = "Admin overrides of provisional vendor spend rates (ENG-2271)";
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
  if (!isEditableProvider(provider)) {
    throw new ValidationError(`Provider "${provider}" is not editable; editable: ${EDITABLE_VENDOR_RATE_PROVIDERS.join(", ")}`);
  }
  if (!isEditableVendorRate(provider, key)) throw new ValidationError(`Unknown rate key "${key}" for ${provider}`);
  if (usdPerUnit !== null && !isValidOverrideRate(usdPerUnit)) {
    throw new ValidationError(`usdPerUnit must be null or a finite number from 0.000001 (at most 6 decimal places) to ${MAX_OVERRIDE_USD_PER_UNIT}`);
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

type Change = ReturnType<typeof parseBody>;

/** The merged overrides after applying one change; `before` is not mutated. */
function applyChange(before: VendorRateOverrides, change: Change): VendorRateOverrides {
  const overrides = structuredClone(before);
  if (change.usdPerUnit === null) {
    const block = overrides[change.provider];
    if (block) {
      delete block[change.key];
      if (Object.keys(block).length === 0) delete overrides[change.provider];
    }
  } else {
    (overrides[change.provider] ??= {})[change.key] = change.usdPerUnit;
  }
  return overrides;
}

/** Conditional write; false means another writer got there first (re-read and retry). */
async function writeOverrides(row: Setting | null, value: string, adminId: string): Promise<boolean> {
  try {
    if (row) {
      await settingsService.setSettingIfValueMatches(VENDOR_RATE_OVERRIDES_SETTING, value, row.settingValue, DESCRIPTION, adminId);
      return true;
    }
    return await settingsService.setSettingIfAbsent(VENDOR_RATE_OVERRIDES_SETTING, value, DESCRIPTION, adminId);
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

const jitter = () => new Promise<void>((r) => setTimeout(r, 20 + Math.random() * 60));

router.put("/vendor-rates", authenticateToken, isAdmin, async (req: AuthRequest, res: Response) => {
  let change: Change;
  try {
    change = parseBody(req.body);
  } catch (error) {
    return res.status(400).json({ error: error instanceof ValidationError ? error.message : "Invalid request" });
  }
  const adminId = req.user?.userId;
  if (!adminId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Read-modify-write guarded by the exact raw value read (optimistic concurrency), so two
    // admins editing different keys cannot silently drop each other's change. A short jittered
    // pause between attempts keeps two quick PUTs from the UI from colliding again.
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      if (attempt > 0) await jitter();
      const row = await settingsService.getSetting(VENDOR_RATE_OVERRIDES_SETTING);
      const before = parseVendorRateOverrides(row?.settingValue);
      const overrides = applyChange(before.overrides, change);
      const value = JSON.stringify({ overrides, updatedAt: new Date().toISOString(), updatedBy: adminId });
      if (!(await writeOverrides(row, value, adminId))) continue;

      console.info(
        `[adminVendorRates] admin=${adminId} ${change.provider}:${change.key} ` +
          `${before.overrides[change.provider]?.[change.key] ?? null} -> ${change.usdPerUnit}`,
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
