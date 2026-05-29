export interface AnalyticsConfigInput {
  seoDomains?: unknown;
  googleAnalyticsProperties?: unknown;
  primaryAnalyticsPropertyId?: unknown;
  gaFilteredDomains?: unknown;
  clarityProjects?: unknown;
  productDomain?: unknown;
}

export interface AnalyticsConfigValue {
  seoDomains?: string[];
  googleAnalyticsProperties?: Array<{ propertyId: string; label: string }>;
  primaryAnalyticsPropertyId?: string | null;
  gaFilteredDomains?: string[];
  clarityProjects?: Array<{ projectId: string; label: string }>;
  productDomain?: string | null;
}

export type ValidationResult =
  | { ok: true; value: AnalyticsConfigValue }
  | { ok: false; error: string };

const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
const URL_PREFIX_RE = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}\/?$/;
const GA_ID_RE = /^\d+$/;
const CLARITY_ID_RE = /^[a-zA-Z0-9_-]{6,32}$/;

/**
 * Validate a partial analytics-config payload. Every field is optional; only
 * provided fields are validated. Returns trimmed/normalized values on success.
 * Shared by the admin route and the self-service /api/seo/config routes.
 */
export function validateAnalyticsConfig(input: AnalyticsConfigInput): ValidationResult {
  const value: AnalyticsConfigValue = {};

  if (input.seoDomains !== undefined) {
    if (!Array.isArray(input.seoDomains)) return { ok: false, error: "seoDomains must be an array" };
    const out: string[] = [];
    for (const d of input.seoDomains) {
      if (typeof d !== "string") return { ok: false, error: `Invalid domain: ${d}` };
      const t = d.trim();
      if (!DOMAIN_RE.test(t) && !URL_PREFIX_RE.test(t)) {
        return { ok: false, error: `Invalid domain format: ${d}. Use 'example.com' or 'https://example.com/'` };
      }
      out.push(t);
    }
    value.seoDomains = out;
  }

  if (input.googleAnalyticsProperties !== undefined) {
    if (!Array.isArray(input.googleAnalyticsProperties)) {
      return { ok: false, error: "googleAnalyticsProperties must be an array" };
    }
    const out: Array<{ propertyId: string; label: string }> = [];
    const seen = new Set<string>();
    for (const p of input.googleAnalyticsProperties as any[]) {
      if (!p || typeof p !== "object" || typeof p.propertyId !== "string" || typeof p.label !== "string") {
        return { ok: false, error: "Each GA4 property must have string 'propertyId' and 'label'" };
      }
      const id = p.propertyId.trim();
      const label = p.label.trim();
      if (!GA_ID_RE.test(id)) return { ok: false, error: `Invalid GA4 Property ID: ${p.propertyId}. Use the numeric ID.` };
      if (label.length === 0) return { ok: false, error: "Each GA4 property must have a non-empty label" };
      if (label.length > 100) return { ok: false, error: `GA4 label too long (max 100): ${p.label}` };
      if (seen.has(id)) return { ok: false, error: `Duplicate GA4 Property ID: ${id}` };
      seen.add(id);
      out.push({ propertyId: id, label });
    }
    value.googleAnalyticsProperties = out;
  }

  if (input.primaryAnalyticsPropertyId !== undefined) {
    const raw = input.primaryAnalyticsPropertyId;
    if (raw === null || raw === "") {
      value.primaryAnalyticsPropertyId = null;
    } else if (typeof raw !== "string") {
      return { ok: false, error: "primaryAnalyticsPropertyId must be a string" };
    } else {
      const id = raw.trim();
      if (!GA_ID_RE.test(id)) {
        return { ok: false, error: `Invalid GA4 Property ID format: ${raw}. Use the numeric Property ID.` };
      }
      const props = value.googleAnalyticsProperties;
      if (props && !props.some((p) => p.propertyId === id)) {
        return { ok: false, error: "primaryAnalyticsPropertyId must be one of the submitted GA4 properties" };
      }
      value.primaryAnalyticsPropertyId = id;
    }
  }

  if (input.gaFilteredDomains !== undefined) {
    if (!Array.isArray(input.gaFilteredDomains)) return { ok: false, error: "gaFilteredDomains must be an array" };
    const out: string[] = [];
    for (const d of input.gaFilteredDomains) {
      if (typeof d !== "string") return { ok: false, error: `Invalid filtered domain: ${d}` };
      const t = d.trim();
      const isLocalhost = t === "localhost" || t.startsWith("localhost:");
      const isIp = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(t);
      if (!isLocalhost && !isIp && !DOMAIN_RE.test(t)) {
        return { ok: false, error: `Invalid filtered domain: ${d}. Use app.example.com, localhost, or an IP.` };
      }
      out.push(t);
    }
    value.gaFilteredDomains = out;
  }

  if (input.clarityProjects !== undefined) {
    if (!Array.isArray(input.clarityProjects)) return { ok: false, error: "clarityProjects must be an array" };
    const out: Array<{ projectId: string; label: string }> = [];
    const seen = new Set<string>();
    for (const p of input.clarityProjects as any[]) {
      if (!p || typeof p !== "object" || typeof p.projectId !== "string" || typeof p.label !== "string") {
        return { ok: false, error: "Each Clarity project must have string 'projectId' and 'label'" };
      }
      const id = p.projectId.trim();
      const label = p.label.trim();
      if (!CLARITY_ID_RE.test(id)) return { ok: false, error: `Invalid Clarity Project ID: ${p.projectId}` };
      if (label.length === 0) return { ok: false, error: "Each Clarity project must have a non-empty label" };
      if (label.length > 100) return { ok: false, error: `Clarity label too long (max 100): ${p.label}` };
      if (seen.has(id)) return { ok: false, error: `Duplicate Clarity Project ID: ${id}` };
      seen.add(id);
      out.push({ projectId: id, label });
    }
    value.clarityProjects = out;
  }

  if (input.productDomain !== undefined) {
    const raw = input.productDomain;
    if (raw === null || raw === "") {
      value.productDomain = null;
    } else if (typeof raw !== "string" || !DOMAIN_RE.test(raw.trim())) {
      return { ok: false, error: `Invalid product domain: ${raw}. Use app.example.com` };
    } else {
      value.productDomain = raw.trim();
    }
  }

  return { ok: true, value };
}
